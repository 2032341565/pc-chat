
import React, { Component } from 'react';
import { observer, inject } from 'mobx-react';

import clazz from 'classname';
import classes from './style.css';
const currentWindow = require('electron').remote.getCurrentWindow();
var ipcRenderer = require('electron').ipcRenderer;
import { isElectron } from '../../../platform'
import { observable, action } from 'mobx';

@inject(stores => ({
    avatar: stores.sessions.avatar,
    code: stores.sessions.code,
}))
@observer
export default class Voip extends Component {

    @observable status = 0;

    moCall;
    isInitiator;
    pcSetuped;
    pooledSignalingMsg = [];
    startTime;
    localStream;
    pc1;
    callTimer;

    callButton;
    hangupButton;
    toVoiceButton;
    switchMicorphone;
    localVideo;
    remoteVideo;

    playIncommingRing() {
        //在界面初始化时播放来电铃声
    }

    stopIncommingRing() {
        //再接听/语音接听/结束媒体时停止播放来电铃声，可能有多次，需要避免出问题
    }

    setup() {
        if (isElectron()) {
            ipcRenderer.on('initCallUI', (event, message) => { // 监听父页面定义的端口
                this.moCall = message.moCall;
                if (message.moCall) {
                    this.callButton.disabled = false;
                    this.hangupButton.disabled = false;
                    this.toVoiceButton.hidden = true;
                    this.switchMicorphone.hidden = true;
                    if (message.audioOnly) {
                        this.localVideo.hidden = true;
                        this.remoteVideo.hidden = true;
                    } else {
                        this.toVoiceButton.hidden = false;
                        this.toVoiceButton.disabled = false;
                    }
                    this.starPreview(false, message.voiceOnly);
                } else {
                    this.playIncommingRing();

                    this.callButton.disabled = false;
                    this.hangupButton.disabled = false;
                    if (message.audioOnly) {
                        this.localVideo.hidden = true;
                        this.remoteVideo.hidden = true;
                        this.toVoiceButton.hidden = true;
                    } else {
                        this.toVoiceButton.hidden = false;
                        this.toVoiceButton.disabled = false;
                    }
                    // this.switchMicorphone.hidden = true;
                }
            });

            ipcRenderer.on('startMedia', (event, message) => { // 监听父页面定义的端口
                this.startMedia(message.isInitiator, message.audioOnly);
            });

            ipcRenderer.on('setRemoteOffer', (event, message) => {
                this.onReceiveRemoteCreateOffer(JSON.parse(message));
            });

            ipcRenderer.on('setRemoteAnswer', (event, message) => {
                this.onReceiveRemoteAnswerOffer(JSON.parse(message));
            });

            ipcRenderer.on('setRemoteIceCandidate', (event, message) => {
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

            ipcRenderer.on('endCall', () => { // 监听父页面定义的端口
                this.endCall();
            });

            ipcRenderer.on('downgrade2Voice', () => {
                this.downgrade2Voice();
            });

            ipcRenderer.on('ping', () => {
                console.log('receive ping');
                ipcRenderer.send('pong');
            });

        } else {

        }
    }

    async starPreview(continueStartMedia, audioOnly) {
        console.log('start preview');
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: !audioOnly });
            console.log('Received local stream', stream);
            this.localVideo.srcObject = stream;
            this.localStream = stream;

            if (continueStartMedia) {
                this.startMedia(this.isInitiator, audioOnly);
            }
        } catch (e) {
            console.log('getUserMedia error', e);
            alert(`getUserMedia() error: ${e.name}`);
        }
        this.callButton.disabled = true;
    }

    async startMedia(initiator, audioOnly) {
        console.log('start media', initiator);
        this.isInitiator = initiator;
        this.startTime = window.performance.now();
        if (!this.localStream) {
            this.starPreview(true, audioOnly);
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
            urls: ['turn:turn.wildfirechat.cn:3478'],
            username: 'wfchat',
            credential: 'wfchat'
        };
        var iceServers = [];
        iceServers.push(iceServer);
        configuration.iceServers = iceServers;
        console.log('RTCPeerConnection configuration:', configuration);

        this.pc1 = new RTCPeerConnection(configuration);
        console.log('Created local peer connection object pc1');
        this.pc1.addEventListener('icecandidate', e => this.onIceCandidate(this.pc1, e));

        this.pc1.addEventListener('iceconnectionstatechange', e => this.onIceStateChange(this.pc1, e));
        this.pc1.addEventListener('track', this.gotRemoteStream);

        if (!audioOnly) {
            this.localStream.getTracks().forEach(track => this.pc1.addTrack(track, this.localStream));
        } else {
            this.localStream.getAudioTracks().forEach(track => this.pc1.addTrack(track, this.localStream));
        }
        console.log('Added local stream to pc1');

        if (this.isInitiator) {
            try {
                console.log('pc1 createOffer start');
                var offerOptions = {
                    offerToReceiveAudio: 1,
                    offerToReceiveVideo: !audioOnly
                }
                const offer = await this.pc1.createOffer(offerOptions);
                await this.onCreateOfferSuccess(offer);
            } catch (e) {
                this.onCreateSessionDescriptionError(e);
            }
        }

        this.callButton.hidden = true;
        this.remoteVideo.hidden = false;
        // this.switchMicorphone.hidden = false;
        if (!audioOnly) {
            if (this.moCall) {
                this.toVoiceButton.hidden = false;
            }
        }
        // this.remoteVideo.setAttribute('style', 'width:200px; z-index:100px; position:absolute; right:20px; float:right;');
        if (audioOnly) {
            this.localVideo.hidden = true;
            this.remoteVideo.hidden = true;
        }
    }

    downgrade2Voice() {
        this.localVideo.hidden = true;
        this.remoteVideo.hidden = true;

        const localVideoTracks = localStream.getVideoTracks();
        if (localVideoTracks && localVideoTracks.length > 0) {
            localVideoTracks.forEach(track => track.stop());
        }

        this.localVideo.srcObject = null;
        this.remoteVideo.srcObject = null;

        this.toVoiceButton.hidden = true;
    }

    getName(pc) {
        return 'pc1';
    }

    getSelectedSdpSemantics() {
        // const sdpSemanticsSelect = document.querySelector('#sdpSemantics');
        // const option = sdpSemanticsSelect.options[sdpSemanticsSelect.selectedIndex];
        // return option.value === '' ? {} : { sdpSemantics: option.value };
        return {};
    }

    call() {
        console.log('voip on call button click');
        this.stopIncommingRing();

        this.callButton.hidden = true;
        this.hangupButton.disabled = false;
        console.log('on call button call');
        ipcRenderer.send('onCallButton');
    }

    onCreateSessionDescriptionError(error) {
        console.log('Failed to create session description');
        // console.log(`Failed to create session description: ${error.toString()}`);
    }

    drainOutSingnalingMessage() {
        console.log('drain pooled msg');
        console.log(this.pooledSignalingMsg.length);
        this.pooledSignalingMsg.forEach((message) => {
            console.log('popup pooled message');
            console.log(message);
            this.onReceiveRemoteIceCandidate(JSON.parse(message));
        });
    }

    async onReceiveRemoteCreateOffer(desc) {
        console.log('pc1 setRemoteDescription start');
        try {
            await this.pc1.setRemoteDescription(desc);
            this.onSetRemoteSuccess(pc1);
        } catch (e) {
            this.onSetSessionDescriptionError(e);
        }

        console.log('pc1 createAnswer start');
        // Since the 'remote' side has no media stream we need
        // to pass in the right constraints in order for it to
        // accept the incoming offer of audio and video.
        try {
            const answer = await this.pc1.createAnswer();
            await this.onCreateAnswerSuccess(answer);
        } catch (e) {
            this.onCreateSessionDescriptionError(e);
        }
    }

    async onCreateOfferSuccess(desc) {
        console.log(`Offer from pc1\n${desc.sdp}`);
        console.log('pc1 setLocalDescription start');
        try {
            await this.pc1.setLocalDescription(desc);
            this.onSetLocalSuccess(this.pc1);
            this.pcSetuped = true;
            this.drainOutSingnalingMessage();
        } catch (e) {
            this.onSetSessionDescriptionError();
        }

        console.log(desc);
        ipcRenderer.send('onCreateAnswerOffer', JSON.stringify(desc));
    }

    onSetLocalSuccess(pc) {
        console.log(`${this.getName(pc)} setLocalDescription complete`);
    }

    onSetRemoteSuccess(pc) {
        console.log(`${this.getName(pc)} setRemoteDescription complete`);
    }

    onSetSessionDescriptionError(error) {
        console.log(`Failed to set session description: ${error.toString()}`);
    }

    gotRemoteStream = (e) => {
        if (this.remoteVideo.srcObject !== e.streams[0]) {
            this.remoteVideo.srcObject = e.streams[0];
            console.log('pc1 received remote stream', e.streams[0]);
        }
    }

    async onReceiveRemoteAnswerOffer(desc) {
        console.log('pc1 setRemoteDescription start');
        try {
            await this.pc1.setRemoteDescription(desc);
            this.onSetRemoteSuccess(this.pc1);
        } catch (e) {
            this.onSetSessionDescriptionError(e);
        }
    }

    async onCreateAnswerSuccess(desc) {
        console.log(`Answer from pc1:\n${desc.sdp}`);
        console.log('pc1 setLocalDescription start');
        try {
            await this.pc1.setLocalDescription(desc);
            this.onSetLocalSuccess(this.pc1);
            this.pcSetuped = true;
            this.drainOutSingnalingMessage();
        } catch (e) {
            this.onSetSessionDescriptionError(e);
        }
        console.log(desc);
        ipcRenderer.send('onCreateAnswerOffer', JSON.stringify(desc));
    }

    async onReceiveRemoteIceCandidate(message) {
        console.log('on receive remote ice candidate');
        await this.pc1.addIceCandidate(message);
    }

    onIceCandidate = (pc, event) => {
        if (!event.candidate) {
            return;
        }
        try {
            ipcRenderer.send('onIceCandidate', JSON.stringify(event.candidate));
            this.onAddIceCandidateSuccess(pc);
        } catch (e) {
            this.onAddIceCandidateError(pc, e);
        }
        console.log(`${this.getName(pc)} ICE candidate:\n${event.candidate ? event.candidate.candidate : '(null)'}`);
    }

    onAddIceCandidateSuccess(pc) {
        console.log(`${this.getName(pc)} send Ice Candidate success`);
    }

    onAddIceCandidateError(pc, error) {
        console.log(`${this.getName(pc)} failed to add ICE Candidate: ${error.toString()}`);
    }

    onUpdateTime() {
        this.elapsedTime = window.performance.now() - this.startTime;
        console.log('Setup time: ' + elapsedTime.toFixed(3) + 'ms');
        // document.getElementById("callTime").innerHTML = this.elapsedTime / 1000;
    }

    @action onIceStateChange = (pc, event) => {
        if (pc) {
            console.log(`${this.getName(pc)} ICE state: ${pc.iceConnectionState}`);
            console.log('ICE state change event: ', event);
            if (pc.iceConnectionState === 'connected') {
                //todo 界面计时开始
                this.callTimer = window.setInterval(this.onUpdateTime, 1000);
                this.status = 2;
            }
            ipcRenderer.send('onIceStateChange', pc.iceConnectionState);
        }
    }

    hangup() {
        console.log('Ending call');
        this.callButton.hidden = true;
        this.hangupButton.hidden = true;
        ipcRenderer.send('onHangupButton');
        this.endCall();
    }

    triggerMicrophone() {
        console.log('trigger microphone');
        if (this.localStream) {
            const audioTracks = this.localStream.getAudioTracks();
            if (audioTracks && audioTracks.length > 0) {
                audioTracks[0].enabled = !audioTracks[0].enabled;
            }
        }
    }

    downToVoice() {
        console.log('down to voice');
        this.stopIncommingRing();
        this.toVoiceButton.disabled = true;
        this.toVoiceButton.hidden = true;
        this.callButton.hidden = true;
        this.hangupButton.disabled = false;
        ipcRenderer.send('downToVoice');
    }

    endCall() {
        console.log('Ending media');
        this.stopIncommingRing();//可能没有接听就挂断了
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

        if (this.pc1) {
            this.pc1.close();
            this.pc1 = null;
        }

        // ipcRenderer.removeListener('startPreview');
        // ipcRenderer.removeListener('startMedia');
        // ipcRenderer.removeListener('setRemoteOffer');
        // ipcRenderer.removeListener('setRemoteAnswer');
        // ipcRenderer.removeListener('setRemoteIceCandidate');
        // ipcRenderer.removeListener('endMedia');
        ipcRenderer.removeAllListeners(['initCallUI', 'startPreview', 'startMedia', 'setRemoteOffer', 'setRemoteAnswer', 'setRemoteIceCandidate', 'endMedia']);

        // 停几秒，显示通话时间，再结束
        // 页面释放有问题没有真正释放掉
        // eslint-disable-next-line no-const-assign
        setTimeout(function () { if (currentWindow) { currentWindow.close(); } }, 2000);
    }

    componentWillMount() {
        this.setup();
    }

    componentDidMount() {
        this.callButton = this.refs.callButton;
        this.hangupButton = this.refs.hangupButton;
        this.toVoiceButton = this.refs.toVoiceButton;
        this.switchMicorphone = this.refs.switchMicorphone;
        this.localVideo = this.refs.localVideo;
        this.remoteVideo = this.refs.remoteVideo;

        console.log('yyyyyyy', this.remoteVideo, this.localVideo);

        // TODO more
    }

    componentWillUnmount() {
    }

    renderAudioIncomingAction() {

    }

    renderAudioOutgoingOrConnectedAction() {

    }

    videoOutgoingDesc() {
        return (
            <div className={classes.videoOutgoing}>
                <img src='assets/images/offline.png'></img>
                <div className={classes.desc}>
                    <p>xxx</p>
                    <p>正在等待对方接受邀请</p>
                </div>
            </div>
        )
    }

    videoOutgoingOrConnectedAction() {
        return (
            <div className={classes.videoOutgoingOrConnectedAction}>
                <div>
                    <p style={{ visibility: 'hidden' }}>holder</p>
                    <img ref="switchMicorphone" src='assets/images/av_mute.png' ref="videoMute"></img>
                    <p>关闭麦克风</p>
                </div>
                <div>
                    <p>10:00</p>
                    <img ref="hangupButton" src='assets/images/av_hang_up.png'></img>
                    <p style={{ visibility: 'hidden' }}>holder</p>
                </div>
                <div>
                    <p style={{ visibility: 'hidden' }}>holder</p>
                    <img ref="toVoiceButton" src='assets/images/av_phone.png'></img>
                    <p>切换到语音聊天</p>
                </div>
            </div>
        )
    }

    videoIncomingDesc() {
        return (
            <div className={clazz(classes.videoInviter)}>
                <img src='assets/images/offline.png'></img>
                <p>xxxx</p>
                <p>邀请你视频通话</p>
            </div>
        )
    }

    videoIncomingAction() {
        return (
            <div>
                <div className={classes.audioAccept}>
                    <img ref="toVoiceButton" src='assets/images/offline.png'></img>
                    <p>切换到语音聊天</p>
                </div>
                <div className={classes.videoIncomingAction}>
                    <img ref="hangupButton" className={classes.incomingHangup} src='assets/images/offline.png'></img>
                    <img ref="callButton" onClick={() => this.call()} className={classes.incomingAccept} src='assets/images/offline.png'></img>
                </div>
            </div >
        )
    }

    audioIncomingDesc() {
        return (
            <div className={clazz(classes.videoInviter)}>
                <img src='assets/images/offline.png'></img>
                <p>xxxx</p>
                <p>邀请你语音聊天</p>
            </div>
        )
    }

    audioIncomingAction() {
        return (
            <div className={classes.videoIncomingAction}>
                <img className={classes.incomingHangup} src='assets/images/offline.png'></img>
                <img className={classes.incomingAccept} src='assets/images/offline.png'></img>
            </div>
        )
    }

    audioOutgoingDesc() {
        return (
            <div className={clazz(classes.videoInviter)}>
                <img src='assets/images/offline.png'></img>
                <p>xxxx</p>
                <p>正在等待对方接受邀请</p>
            </div>
        )
    }

    audioOutgoingAction() {
        return (
            <div className={classes.videoIncomingAction}>
                <img className={classes.audioIncomingHangup} src='assets/images/offline.png'></img>
            </div>
        )
    }

    audioConnectedDesc() {
        return (
            <div className={clazz(classes.videoInviter)}>
                <img src='assets/images/offline.png'></img>
                <p>xxxx</p>
                <p>00:03</p>
            </div>
        )
    }

    audioConnectedAction() {
        return (
            <div className={classes.audioConnectedAction}>
                <div>
                    <img className={classes.audioIncomingHangup} src='assets/images/offline.png'></img>
                    <p>关闭麦克风</p>
                </div>
                <img className={classes.audioIncomingHangup} src='assets/images/offline.png'></img>
            </div>
        )
    }

    audioIncomingAction() {
        return (
            <div className={classes.videoIncomingAction}>
                <img className={classes.incomingHangup} src='assets/images/offline.png'></img>
                <img className={classes.incomingAccept} src='assets/images/offline.png'></img>
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

    renderVideo() {
        return (
            <div className={classes.container}>
                <video ref="localVideo" className={classes.remoteVideo} playsInline autoPlay muted >

                </video>

                <video ref="remoteVideo" className={classes.localVideo} playsInline autoPlay hidden={false} >
                </video>
                {this.status < 2 ? this.renderIncomingVideo() : this.renderConnectedVideo()
                }

            </div>
        );
    }

    renderAudio() {

    }

    render() {
        // incominig
        return this.renderVideo();
        // if (this.status === 1) {
        //     return this.renderVideo();
        //     // incoming connected
        // } else if (this.status === 2) {
        //     return (
        //         <div className={classes.cobntainer}>
        //             <video className={classes.localVideo}>

        //             </video>

        //             <video className={classes.remoteVideo}>

        //             </video>
        //             <div className={classes.action}>
        //                 <img className={classes.hangup} src='assets/images/offline.png'></img>
        //                 <img className={classes.accept} src='assets/images/offline.png'></img>
        //             </div>
        //         </div>
        //     );

        //     // outgoing
        // } else {

        // }
    }
}
