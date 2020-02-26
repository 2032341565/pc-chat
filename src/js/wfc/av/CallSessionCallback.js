export default class CallSessionCallback {

    onInitial(session, selfUserInfo, participantUserInfos) {

    }

    didCallEndWithReason(reason) {

    }

    didChangeState(state) {

    }

    didParticipantJoined(userId) {

    }

    didParticipantLeft(userId, callEndReason) {

    }

    didChangeMode(audioOnly) {

    }

    didCreateLocalVideoTrack(stream) {

    }

    didError(error) {

    }

    didGetStats(reports) {

    }

    didReceiveRemoteVideoTrack(userId, stream) {

    }

    didRemoveRemoteVideoTrack(userId) {

    }

    didVideoMuted(userId, muted) {

    }
}
