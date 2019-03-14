import MediaMessageContent from './mediaMessageContent'
import MessageContentMediaType from './messageContentMediaType';
import MessageContentType from './messageContentType';
export default class VideoMessageContent extends MediaMessageContent {
    // base64 encoded
    thumbnail;
    constructor(thumbnail) {
        super(MessageContentType.Video);
        this.thumbnail = thumbnail;
    }

    digest() {
        return '[视频]';
    }

    encode() {
        let payload = super.encode();
        payload.mediaType = MessageContentMediaType.Video;
        payload.binaryContent = thumbnail;
    };

    decode(payload) {
        super.decode(payload);
        this.thumbnail = payload.binaryContent;
    }
}
