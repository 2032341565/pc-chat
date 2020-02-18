import React, {Component} from 'react';
import {observer, inject} from 'mobx-react';

import clazz from 'classname';
import classes from './style.css';
import {ipcRenderer, isElectron, currentWindow, PostMessageEventEmitter} from '../../../../platform'
import {observable, action} from 'mobx';
import Config from '../../../../config.js';

@inject(stores => ({
    avatar: stores.sessions.avatar,
    code: stores.sessions.code,
}))
@observer
export default class Voip extends Component {

    static STATUS_IDLE = 0;
    static STATUS_OUTGOING = 1;
    static STATUS_INCOMING = 2;
    static STATUS_CONNECTING = 3;
    static STATUS_CONNECTED = 4;

    @observable status = 0;
    @observable audioOnly = false;
    @observable duration = '0:0';
    @observable muted = false;

    targetUserInfo;
    targetUserDisplayName;

    moCall; // true, outgoing; false, incoming
    isInitiator;
    pcSetuped;
    queuedOffer;
    pooledSignalingMsg = [];
    startTime;
    localStream;
    pc;
    callTimer;

    callButton;
    hangupButton;
    toVoiceButton;
    switchMicrophone;
    localVideo;
    remoteVideo;

    events;


    drainOfferMessage() {
        if (!this.queuedOffer) {
            return false;
        }

        this.onReceiveRemoteCreateOffer(this.queuedOffer);
        this.queuedOffer = null;
    }

    queueOfferMessage(desc) {
        this.queuedOffer = desc;
    }

    playIncomingRing() {
        //在界面初始化时播放来电铃声
    }

    stopIncomingRing() {
        //再接听/语音接听/结束媒体时停止播放来电铃声，可能有多次，需要避免出问题
    }

    voipEventEmit(event, args) {
        if (isElectron()) {
            // renderer to main
            ipcRenderer.send(event, args);
        } else {
            this.events.emit(event, args);
        }
    }

    voipEventOn = (event, listener) => {
        if (isElectron()) {
            // listen for event from renderer
            ipcRenderer.on(event, listener);
        } else {
            this.events.on(event, listener);
        }
    }

    voipEventRemoveAllListeners(events = []) {
        if (isElectron()) {
            // renderer
            events.forEach(e => ipcRenderer.removeAllListeners(e));
        } else {
            this.events.stop();
        }
    }

    setup() {
        if (!isElectron()) {
            this.events = new PostMessageEventEmitter(window.opener, window.location.origin);
        }

        this.voipEventOn('initCallUI', (event, message) => { // 监听父页面定义的端口
            this.moCall = message.moCall;
            this.audioOnly = message.audioOnly;
            this.targetUserInfo = message.targetUserInfo;
            this.targetUserDisplayName = message.targetUserDisplayName;

            if (message.moCall) {
                this.status = Voip.STATUS_OUTGOING;
                this.startPreview(false, message.voiceOnly);
            } else {
                this.status = Voip.STATUS_INCOMING;
                this.playIncomingRing();
            }
        });

        this.voipEventOn('startMedia', (event, message) => { // 监听父页面定义的端口
            this.startMedia(message.isInitiator, message.audioOnly);
        });

        this.voipEventOn('setRemoteOffer', (event, message) => {
            this.onReceiveRemoteCreateOffer(JSON.parse(message));
        });

        this.voipEventOn('setRemoteAnswer', (event, message) => {
            this.onReceiveRemoteAnswerOffer(JSON.parse(message));
        });

        this.voipEventOn('setRemoteIceCandidate', (event, message) => {
            console.log('setRemoteIceCandidate');
            console.log(message);
            if (!this.pcSetuped) {
                console.log('pc not setup yet pool it');
                this.pooledSignalingMsg.push(message);
            } else {
                console.log('handle the candidiated');
                this.onReceiveRemoteIceCandidate(JSON.parse(message));
            }
        });

        this.voipEventOn('endCall', () => { // 监听父页面定义的端口
            this.endCall();
        });

        this.voipEventOn('downgrade2Voice', () => {
            this.downgrade2Voice();
        });

        this.voipEventOn('ping', () => {
            console.log('receive ping');
            this.voipEventEmit('pong');
        });

    }

    async startPreview(continueStartMedia, audioOnly) {
        console.log('start preview');
        try {
            const stream = await navigator.mediaDevices.getUserMedia({audio: true, video: !audioOnly});
            console.log('Received local stream', stream);
            this.localVideo.srcObject = stream;
            this.localStream = stream;

            if (continueStartMedia) {
                this.startMedia(this.isInitiator, audioOnly);
            }
        } catch (e) {
            console.log('getUserMedia error', e);
            alert(`getUserMedia() error: ${e.name}`);
            this.endCall();
        }
    }


    async startMedia(initiator, audioOnly) {
        console.log('start media', initiator);
        this.isInitiator = initiator;
        this.status = Voip.STATUS_CONNECTING;
        this.startTime = window.performance.now();
        if (!this.localStream) {
            this.startPreview(true, audioOnly);
            return;
        } else {
            console.log('start pc');
        }

        const videoTracks = this.localStream.getVideoTracks();
        if (!audioOnly) {
            if (videoTracks && videoTracks.length > 0) {
                console.log(`Using video device: ${videoTracks[0].label}`);
            }
        } else {
            if (videoTracks && videoTracks.length > 0) {
                videoTracks.forEach(track => track.stop());
            }
        }

        const audioTracks = this.localStream.getAudioTracks();
        if (audioTracks.length > 0) {
            console.log(`Using audio device: ${audioTracks[0].label}`);
        }
        var configuration = this.getSelectedSdpSemantics();
        var iceServer = {
            urls: [Config.ICE_ADDRESS],
            username: Config.ICE_USERNAME,
            credential: Config.ICE_PASSWORD
        };
        var iceServers = [];
        iceServers.push(iceServer);
        configuration.iceServers = iceServers;
        console.log('RTCPeerConnection configuration:', configuration);

        this.pc = new RTCPeerConnection(configuration);
        console.log('Created local peer connection object pc');
        this.pc.addEventListener('icecandidate', e => this.onIceCandidate(this.pc, e));

        this.pc.addEventListener('iceconnectionstatechange', e => this.onIceStateChange(this.pc, e));
        this.pc.addEventListener('track', this.gotRemoteStream);

        if (!audioOnly) {
            this.localStream.getTracks().forEach(track => this.pc.addTrack(track, this.localStream));
        } else {
            this.localStream.getAudioTracks().forEach(track => this.pc.addTrack(track, this.localStream));
        }
        console.log('Added local stream to pc');

        if (this.isInitiator) {
            try {
                console.log('pc createOffer start');
                var offerOptions = {
                    offerToReceiveAudio: 1,
                    offerToReceiveVideo: !audioOnly
                }
                const offer = await this.pc.createOffer(offerOptions);
                var mutableOffer = JSON.parse(JSON.stringify(offer));
                mutableOffer.type = 'offer';
                await this.onCreateOfferSuccess(offer);
            } catch (e) {
                this.onCreateSessionDescriptionError(e);
            }
        }

        this.drainOfferMessage();
    }

    downgrade2Voice() {
        if (this.status !== Voip.STATUS_CONNECTED) {
            return
        }
        this.audioOnly = true;

        const localVideoTracks = this.localStream.getVideoTracks();
        if (localVideoTracks && localVideoTracks.length > 0) {
            localVideoTracks.forEach(track => track.stop());
        }

        this.localVideo.srcObject = null;
        this.remoteVideo.srcObject = null;

        this.voipEventEmit('downToVoice');
    }

    getSelectedSdpSemantics() {
        // const sdpSemanticsSelect = document.querySelector('#sdpSemantics');
        // const option = sdpSemanticsSelect.options[sdpSemanticsSelect.selectedIndex];
        // return option.value === '' ? {} : { sdpSemantics: option.value };
        return {};
    }

    call() {
        console.log('voip on call button click');
        this.stopIncomingRing();

        this.status = Voip.STATUS_CONNECTING;
        console.log('on call button call');
        this.voipEventEmit('onCallButton');
    }

    onCreateSessionDescriptionError(error) {
        console.log('Failed to create session description');
        // console.log(`Failed to create session description: ${error.toString()}`);
        this.endCall();
    }

    drainOutSignalingMessage() {
        console.log('drain pooled msg');
        console.log(this.pooledSignalingMsg.length);
        this.pooledSignalingMsg.forEach((message) => {
            console.log('popup pooled message');
            console.log(message);
            this.onReceiveRemoteIceCandidate(JSON.parse(message));
        });
    }

    async onReceiveRemoteCreateOffer(desc) {
        console.log('pc setRemoteDescription start');
        if (this.status !== Voip.STATUS_CONNECTING && this.status !== Voip.STATUS_CONNECTED) {
            this.queueOfferMessage(desc);
            return;
        }
        try {
            await this.pc.setRemoteDescription(desc);
            this.onSetRemoteSuccess(this.pc);
        } catch (e) {
            this.onSetSessionDescriptionError(e);
        }

        console.log('pc createAnswer start');
        // Since the 'remote' side has no media stream we need
        // to pass in the right constraints in order for it to
        // accept the incoming offer of audio and video.
        try {
            const answer = await this.pc.createAnswer();
            var mutableAnswer = JSON.parse(JSON.stringify(answer));
            mutableAnswer.type = 'answer';
            await this.onCreateAnswerSuccess(answer);
        } catch (e) {
            this.onCreateSessionDescriptionError(e);
        }
    }

    async onCreateOfferSuccess(desc) {
        console.log(`Offer from pc\n${desc.sdp}`);
        console.log('pc setLocalDescription start');
        try {
            await this.pc.setLocalDescription(desc);
            this.onSetLocalSuccess(this.pc);
            this.pcSetuped = true;
            this.drainOutSignalingMessage();
        } catch (e) {
            this.onSetSessionDescriptionError();
        }

        console.log(desc);
        this.voipEventEmit('onCreateAnswerOffer', JSON.stringify(desc));
    }

    onSetLocalSuccess(pc) {
        console.log(`setLocalDescription complete`);
    }

    onSetRemoteSuccess(pc) {
        console.log(`setRemoteDescription complete`);
    }

    onSetSessionDescriptionError(error) {
        console.log(`Failed to set session description: ${error.toString()}`);
        this.endCall();
    }

    gotRemoteStream = (e) => {
        if (this.remoteVideo.srcObject !== e.streams[0]) {
            this.remoteVideo.srcObject = e.streams[0];
            console.log('pc received remote stream', e.streams[0]);
        }
    }

    async onReceiveRemoteAnswerOffer(desc) {
        console.log('pc setRemoteDescription start');
        try {
            await this.pc.setRemoteDescription(desc);
            this.onSetRemoteSuccess(this.pc);
        } catch (e) {
            this.onSetSessionDescriptionError(e);
        }
    }

    async onCreateAnswerSuccess(desc) {
        console.log(`Answer from pc:\n${desc.sdp}`);
        console.log('pc setLocalDescription start');
        try {
            await this.pc.setLocalDescription(desc);
            this.onSetLocalSuccess(this.pc);
            this.pcSetuped = true;
            this.drainOutSignalingMessage();
        } catch (e) {
            this.onSetSessionDescriptionError(e);
        }
        console.log(desc);
        this.voipEventEmit('onCreateAnswerOffer', JSON.stringify(desc));
    }

    async onReceiveRemoteIceCandidate(message) {
        console.log('on receive remote ice candidate');
        await this.pc.addIceCandidate(message);
    }

    onIceCandidate = (pc, event) => {
        if (!event.candidate) {
            return;
        }
        try {
            let candidate = {
                type: 'candidate',
                label: event.candidate.sdpMLineIndex,
                id: event.candidate.sdpMid,
                candidate: event.candidate.candidate
            };
            this.voipEventEmit('onIceCandidate', JSON.stringify(candidate));
            this.onAddIceCandidateSuccess(pc);
        } catch (e) {
            this.onAddIceCandidateError(pc, e);
        }
        console.log(`ICE candidate:\n${event.candidate ? event.candidate.candidate : '(null)'}`);
    }

    onAddIceCandidateSuccess(pc) {
        console.log(`send Ice Candidate success`);
    }

    onAddIceCandidateError(pc, error) {
        console.log(`failed to add ICE Candidate: ${error.toString()}`);
        this.endCall();
    }

    @action onUpdateTime = () => {
        let elapsedTime = window.performance.now() - this.startTime;
        elapsedTime /= 1000;
        this.duration = parseInt(elapsedTime / 60) + ':' + parseInt(elapsedTime % 60);
        console.log(this.duration);
    }

    @action onIceStateChange = (pc, event) => {
        if (pc) {
            console.log(`ICE state: ${pc.iceConnectionState}`, pc);
            console.log('ICE state change event: ', event);
            if (pc.iceConnectionState === 'connected') {
                this.status = Voip.STATUS_CONNECTED;
                this.startTime = window.performance.now();
                this.callTimer = window.setInterval(this.onUpdateTime, 1000);
            }
            this.voipEventEmit('onIceStateChange', pc.iceConnectionState);
        }
    }

    hangup() {
        console.log('Ending call');
        this.voipEventEmit('onHangupButton');
        this.endCall();
    }

    triggerMicrophone() {
        console.log('trigger microphone');
        if (this.localStream) {
            const audioTracks = this.localStream.getAudioTracks();
            if (audioTracks && audioTracks.length > 0) {
                audioTracks[0].enabled = !audioTracks[0].enabled;
                this.muted = !this.muted;
            }
        }
    }

    downToVoice() {
        console.log('down to voice');
        this.stopIncomingRing();
        this.voipEventEmit('downToVoice');
    }

    endCall() {
        console.log('Ending media');
        this.status = Voip.STATUS_IDLE;
        this.stopIncomingRing();//可能没有接听就挂断了
        if (this.callTimer) {
            clearInterval(this.callTimer);
        }

        if (this.localStream) {
            if (typeof this.localStream.getTracks === 'undefined') {
                // Support legacy browsers, like phantomJs we use to run tests.
                this.localStream.stop();
            } else {
                this.localStream.getTracks().forEach(function (track) {
                    track.stop();
                });
            }
            this.localStream = null;
        }

        if (this.pc) {
            this.pc.close();
            this.pc = null;
        }

        // ipcRenderer.removeListener('startPreview');
        // ipcRenderer.removeListener('startMedia');
        // ipcRenderer.removeListener('setRemoteOffer');
        // ipcRenderer.removeListener('setRemoteAnswer');
        // ipcRenderer.removeListener('setRemoteIceCandidate');
        // ipcRenderer.removeListener('endMedia');
        this.voipEventRemoveAllListeners(['initCallUI', 'startPreview', 'startMedia', 'setRemoteOffer', 'setRemoteAnswer', 'setRemoteIceCandidate', 'endMedia']);

        // 停几秒，显示通话时间，再结束
        // 页面释放有问题没有真正释放掉
        // eslint-disable-next-line no-const-assign
        // TODO web
        setTimeout(() => {
            if (currentWindow) {
                currentWindow.close();
            } else {
                window.close();
            }
        }, 2000);
    }

    componentWillMount() {
        this.setup();
    }

    componentDidMount() {
        this.callButton = this.refs.callButton;
        this.hangupButton = this.refs.hangupButton;
        this.toVoiceButton = this.refs.toVoiceButton;
        this.switchMicrophone = this.refs.switchMicorphone;
        this.localVideo = this.refs.localVideo;
        this.remoteVideo = this.refs.remoteVideo;

        // TODO more
    }

    componentWillUnmount() {
    }

    videoOutgoingDesc() {
        return (
            <div className={classes.videoOutgoing}>
                <img src={this.targetUserInfo.portrait}></img>
                <div className={classes.desc}>
                    <p>{this.targetUserDisplayName}</p>
                    <p>正在等待对方接受邀请</p>
                </div>
            </div>
        )
    }

    videoOutgoingOrConnectedAction() {
        return (
            <div className={classes.videoOutgoingOrConnectedAction}>
                <div>
                    <p style={{visibility: 'hidden'}}>holder</p>
                    <img ref="switchMicorphone"
                         src={this.muted ? 'assets/images/av_mute_hover.png' : 'assets/images/av_mute.png'}
                         onClick={() => this.triggerMicrophone()}
                    >
                    </img>
                    <p>关闭麦克风</p>
                </div>
                <div>
                    <p>{this.duration}</p>
                    <img ref="hangupButton"
                         onClick={() => this.hangup()}
                         src='assets/images/av_hang_up.png'></img>
                    <p style={{visibility: 'hidden'}}>holder</p>
                </div>
                <div>
                    <p style={{visibility: 'hidden'}}>holder</p>
                    <img ref="toVoiceButton"
                         src='assets/images/av_phone.png'
                         onClick={() => this.downgrade2Voice()}
                    />
                    <p>切换到语音聊天</p>
                </div>
            </div>
        )
    }

    videoIncomingDesc() {
        return (
            <div className={clazz(classes.videoInviter)}>
                <img src={this.targetUserInfo.portrait}></img>
                <p>{this.targetUserDisplayName}</p>
                <p>邀请你视频通话</p>
            </div>
        )
    }

    videoIncomingAction() {
        return (
            <div>
                <div className={classes.audioAccept}>
                    <img ref="toVoiceButton"
                         onClick={() => this.downToVoice()}
                         src='assets/images/av_float_audio.png'>
                    </img>
                    <p>切换到语音聊天</p>
                </div>
                <div className={classes.videoIncomingAction}>
                    <img ref="hangupButton"
                         onClick={() => this.hangup()}
                         className={classes.incomingHangup}
                         src='assets/images/av_hang_up.png'>

                    </img>
                    <img ref="callButton"
                         onClick={() => this.call()}
                         className={classes.incomingAccept}
                         src='assets/images/av_video_answer.png'></img>
                </div>
            </div>
        )
    }

    audioIncomingDesc() {
        return (
            <div className={clazz(classes.videoInviter)}>
                <img src={this.targetUserInfo.portrait}></img>
                <p>{this.targetUserDisplayName}</p>
                <p>邀请你语音聊天</p>
            </div>
        )
    }

    audioIncomingAction() {
        return (
            <div className={classes.videoIncomingAction}>
                <img className={classes.incomingHangup} src='assets/images/av_hang_up.png'></img>
                <img className={classes.incomingAccept} src='assets/images/av_video_answer.png'></img>
            </div>
        )
    }

    audioOutgoingDesc() {
        return (
            <div className={clazz(classes.videoInviter)}>
                <img src={this.targetUserInfo.portrait}></img>
                <p>{this.targetUserDisplayName}</p>
                <p>正在等待对方接受邀请</p>
            </div>
        )
    }

    audioOutgoingAction() {
        return (
            <div className={classes.videoIncomingAction}>
                <img
                    className={classes.audioIncomingHangup}
                    onClick={() => this.hangup()}
                    src='assets/images/av_hang_up.png'></img>
            </div>
        )
    }

    audioConnectedDesc() {
        return (
            <div className={clazz(classes.videoInviter)}>
                <img src={this.targetUserInfo.portrait}></img>
                <p>{this.targetUserDisplayName}</p>
                <p>{this.duration}</p>
            </div>
        )
    }

    audioConnectedAction() {
        return (
            <div className={classes.audioConnectedAction}>
                <div>
                    <img className={classes.audioIncomingHangup}
                         onClick={e => this.triggerMicrophone()}
                         src={this.muted ? 'assets/images/av_mute_hover.png' : 'assets/images/av_mute.png'}/>
                    <p>关闭麦克风</p>
                </div>
                <img className={classes.audioIncomingHangup}
                     onClick={e => this.hangup()}
                     src='assets/images/av_hang_up.png'></img>
            </div>
        )
    }

    audioIncomingAction() {
        return (
            <div className={classes.videoIncomingAction}>
                <img className={classes.incomingHangup}
                     onClick={e => this.hangup()}
                     src='assets/images/av_hang_up.png'
                ></img>
                <img className={classes.incomingAccept}
                     onClick={e => this.call()}
                     src='assets/images/av_video_answer.png'
                ></img>
            </div>
        )
    }

    renderIncomingAudio() {
        return (
            <div>
                {
                    this.audioIncomingDesc()
                }
                {
                    this.audioIncomingAction()
                }
            </div>
        )
    }

    renderOutgoingAudio() {
        return (
            <div>
                {
                    this.audioOutgoingDesc()
                }
                {

                    this.audioOutgoingAction()
                }
            </div>
        )
    }

    renderConnectedAudio() {
        return (
            <div>
                {
                    this.audioConnectedDesc()
                }
                {

                    this.audioConnectedAction()
                }
            </div>
        )
    }

    renderIncomingVideo() {
        return (
            <div>
                {
                    this.videoIncomingDesc()
                }
                {

                    this.videoIncomingAction()
                }
            </div>
        )
    }

    renderOutgoingVideo() {
        return (
            <div>
                {
                    this.videoOutgoingDesc()
                }
                {
                    this.videoOutgoingOrConnectedAction()
                }
            </div>
        )
    }

    renderConnectedVideo() {
        return this.videoOutgoingOrConnectedAction()
    }

    renderIdle() {
        // return (
        //     <div>
        //         <p>WFC Voip</p>
        //     </div>
        // );
    }

    renderVideo() {
        let renderFn;
        switch (this.status) {
            case Voip.STATUS_IDLE:
                renderFn = this.renderIdle;
                break;
            case Voip.STATUS_INCOMING:
                renderFn = this.renderIncomingVideo;
                break;
            case Voip.STATUS_OUTGOING:
                renderFn = this.renderOutgoingVideo;
                break;
            case Voip.STATUS_CONNECTING:
            case Voip.STATUS_CONNECTED:
                renderFn = this.renderConnectedVideo;
                break;
            default:
                break;

        }
        return (
            <div className={classes.container}>
                <video ref="localVideo" className={classes.localVideo} playsInline autoPlay muted>

                </video>

                <video ref="remoteVideo" className={classes.remoteVideo} playsInline autoPlay hidden={false}>
                </video>
                {
                    renderFn.bind(this)()
                }

            </div>
        );
    }

    renderAudio() {
        let renderFn;
        switch (this.status) {
            case Voip.STATUS_IDLE:
                renderFn = this.renderIdle;
                break;
            case Voip.STATUS_INCOMING:
                renderFn = this.renderIncomingAudio;
                break;
            case Voip.STATUS_OUTGOING:
                renderFn = this.renderOutgoingAudio;
                break;
            case Voip.STATUS_CONNECTING:
            case Voip.STATUS_CONNECTED:
                renderFn = this.renderConnectedAudio;
                break;
            default:
                break;

        }
        return (
            <div className={classes.container}>
                {
                    renderFn.bind(this)()
                }

            </div>
        );

    }

    render() {
        return this.audioOnly ? this.renderAudio() : this.renderVideo();
    }
}
