import React, {Component} from 'react';
import logo from './logo.svg';
import './App.css';

let rpc_id = 0;
let offerId = null;
const remotePeerIds = {};

const msg = (method, params, remotePeerId) => {
    const msg = {
        jsonrpc: '2.0',
        method,
        id: rpc_id++
    };
    if (params) {
        msg.params = params;
        if (remotePeerId) {
            remotePeerIds[msg.id] = remotePeerId;
        }
        if (params.sdpOffer && method === 'publishVideo') {
            offerId = msg.id;
        }
    }
    console.log('message', msg, JSON.stringify(msg));
    return JSON.stringify(msg);
};

class App extends Component {
    constructor(props) {
        super(props);
        this.configuration = { iceServers: [
            { url: 'stun:stun.voiparound.com', urls: ['stun:stun.voiparound.com'] },
            { url: 'stun:stun.schlund.de', urls: ['stun:stun.schlund.de'] }
        ] };
        this.constraints = { mandatory: { offerToReceiveAudio: false, offerToReceiveVideo: false }, optional: [{ DtlsSrtpKeyAgreement: true }] };
        this.pcPeers = {};
        this.iceCandidates = [];
        this.localStream = null;
        this.state = {
            room: '',
            name: '',
            info: 'Initializing',
            status: 'init',
            roomID: '',
            connected: false,
            isFront: true,
            selfViewSrc: null,
            remoteList: {},
            textRoomConnected: false,
            textRoomData: [],
            textRoomValue: ''
        };

        this.socket = new WebSocket('wss://example.com:8443/room');
        this.socket.onopen = () => {
            console.log('connection opened');
            navigator.getUserMedia(
                {
                    audio: true,
                    video: true
                },
                stream => {
                    this.localStream = stream;
                    this.setState({ ...this.state, selfViewSrc: URL.createObjectURL(stream), status: 'ready', info: 'Please enter or create room ID' });
                    console.log(stream);
                },
                error => {
                    console.log(error);
                }
            );
        };
        this.socket.onmessage = (e) => {
            console.log('a message was received');
            const data = JSON.parse(e.data);
            console.log(data);
            switch (data.method) {
                case 'participantJoined':
                    this.setState({ ...this.state, info: `User ${data.params.id} joined the room` });
                    break;
                case 'participantLeft':
                    this.setState({ ...this.state, info: `User ${data.params.name} left the room` });
                    break;
                case 'participantPublished':
                    this.setState({ ...this.state, info: `User ${data.params.id} published video` });
                    this.exchange({ peerId: data.params.id });
                    break;
                case 'participantUnpublished':
                    this.setState({ ...this.state, info: `User ${data.params.name} unpublished video` });
                    break;
                case 'iceCandidate': // received ICE candidate
                    console.log(data.params.endpointName);
                    this.onIceCandidate(this.pcPeers[data.params.endpointName], { ...data.params });
                    // this.exchange({ ...data.params, sessionId: data.params.endpointName }); // sessionId ?
                    break;
                case 'mediaError':
                    this.setState({ ...this.state, info: `MediaError: ${data.params.error}` });
                    break;
            }
            if (data.result && data.result.value && data.result.sessionId && !data.result.sdpAnswer) { // joined a room
                // this.createPC(data.result.sessionId, true);
                this.createPC(this.state.name, true);
                data.result.value.forEach((remotePeer) => {
                    this.createPC(remotePeer.id, false);
                });
            }
            if (data.result && data.result.sdpAnswer) { // received sdp answer
                console.log('received sdpAnswer', data);
                if (data.id === offerId) {
                    console.log('sdpAnswer data.id === offerId', data.id);
                    this.onSdpAnswer(this.state.name, data.result.sdpAnswer);
                } else {
                    console.log('sdpAnswer data.id !== offerId', data.id);
                    const peerId = remotePeerIds[data.id];
                    if (peerId) {
                        this.onSdpAnswer(remotePeerIds[data.id], data.result.sdpAnswer);
                    } else {
                        console.log(remotePeerIds, data.id);
                    }
                }
                //this.exchange({ ...data.result, sdp: data.result.sdpAnswer, type: 'offer', sessionId: 'pc' });
            }
        };
        this.socket.onerror = (e) => {
            console.log('an error occurred', e.message);
        };
        this.socket.onclose = (e) => {
            console.log('connection closed', e.code, e.reason);
        };

        this.handleRoomChange = this.handleRoomChange.bind(this);
        this.handleNameChange = this.handleNameChange.bind(this);
        this.handleSubmit = this.handleSubmit.bind(this);
        this.handleLeave = this.handleLeave.bind(this);
    }

    createPC = (peerId, isOffer) => {
        console.log('createPC', peerId);
        const pc = new window.RTCPeerConnection(this.configuration);
        this.pcPeers[peerId] = pc;
        if (isOffer) this.setState({ ...this.state, connected: true });

        pc.onicecandidate = (event) => {
            console.log('onicecandidate', event, event.candidate);
            if (event.candidate) { // TODO this caused createOffer loops
                this.socket.send(msg('onIceCandidate', { endpointName: peerId, ...event.candidate }));
            }
        };

        pc.onnegotiationneeded = () => {
            console.log('onnegotiationneeded', isOffer);
            if (isOffer) {
                pc.createOffer((desc) => {
                    console.log('createOffer', desc);
                    pc.setLocalDescription(desc, () => {
                        console.log('setLocalDescription', pc.localDescription);
                        this.socket.send(msg('publishVideo', { sdpOffer: pc.localDescription.sdp, doLoopback: false }));
                    }, console.log);
                }, console.log, { mandatory: { offerToReceiveAudio: false, offerToReceiveVideo: false }, optional: [{ DtlsSrtpKeyAgreement: true }] });
            } else {
                pc.createOffer((desc) => {
                    console.log('createOffer', desc);
                    pc.setLocalDescription(desc, () => {
                        console.log('setLocalDescription', pc.localDescription);
                        this.socket.send(msg('receiveVideoFrom', { sender: `${peerId}_webcam`, sdpOffer: pc.localDescription.sdp }, peerId));
                    }, console.log);
                }, console.log, { mandatory: { offerToReceiveAudio: true, offerToReceiveVideo: true }, optional: [{ DtlsSrtpKeyAgreement: true }] });
            }
        };

        pc.oniceconnectionstatechange = (event) => {
            console.log('oniceconnectionstatechange', event.target.iceConnectionState);
            // if (event.target.iceConnectionState === 'completed') {
            //     setTimeout(() => {
            //         this.getStats();
            //     }, 1000);
            // }
            // if (event.target.iceConnectionState === 'connected') {
            //     createDataChannel();
            // }
        };

        pc.onsignalingstatechange = (event) => {
            console.log('onsignalingstatechange', event.target.signalingState);
        };

        pc.onaddstream = (event) => {
            console.log('onaddstream', event, event.stream);
            const remoteList = this.state.remoteList;
            remoteList[peerId] = URL.createObjectURL(event.stream);
            this.setState({ ...this.state, remoteList, info: 'One peer join!' });
        };

        pc.onremovestream = (event) => {
            console.log('onremovestream', event.stream);
        };

        pc.addStream(this.localStream);

        return pc;
    };

    exchange = (data) => {
        const fromId = data.peerId;
        let pc;
        if (fromId in this.pcPeers) {
            pc = this.pcPeers[fromId];
        } else {
            pc = this.createPC(fromId, false);
        }
        console.log('exchange data', data);
        pc.createOffer((desc) => {
            console.log('createOffer', desc);
            pc.setLocalDescription(desc, () => {
                console.log('setLocalDescription', pc.localDescription);
                this.socket.send(msg('receiveVideoFrom', { sender: `${fromId}_webcam`, sdpOffer: pc.localDescription.sdp }, fromId));
            }, console.log);
        }, console.log, { mandatory: { offerToReceiveAudio: true, offerToReceiveVideo: true }, optional: [{ DtlsSrtpKeyAgreement: true }] });
        // const data1 = { sdp: data.sdp.replace('setup:active', 'setup:actpass'), type: data.type };
        // pc.setRemoteDescription(new RTCSessionDescription(data), () => {
        //     if (pc.remoteDescription.type === 'offer') { // TODO offer
        //         pc.createAnswer((desc) => {
        //             console.log('createAnswer', desc);
        //             pc.setLocalDescription(desc, () => {
        //                 console.log('setLocalDescription', pc.localDescription);
        //                 //this.socket.send(msg('publishVideo', { sdpOffer: pc.localDescription.sdp, doLoopback: false }));
        //                 this.socket.send(msg('receiveVideoFrom', { sender: 'pc_webcam', sdpOffer: pc.remoteDescription.sdp }));
        //             }, (error) => console.log('setLocalDescription error', error));
        //         }, (error) => console.log('createAnswer error', error));
        //     }
        // }, console.log);
    };

    onIceCandidate = (pc, candidate) => {
        const iceCandidate = new RTCIceCandidate(candidate);
        if (pc) {
            pc.addIceCandidate(iceCandidate);
        }
        // We save the ice candidate for later when we receive the SDP
        this.iceCandidates.push(iceCandidate);
    };

    onSdpAnswer = (peerId, sdpAnswer) => {
        console.log('onSdpAnswer', peerId);
        const sessionDescription = {
            type: 'answer',
            sdp: sdpAnswer
        };
        const pc = this.pcPeers[peerId];
        if (pc)
            pc.setRemoteDescription(new RTCSessionDescription(sessionDescription), () => {
                // After receiving the SDP we add again the ice candidates, in case they were forgotten (bug)
                this.iceCandidates.forEach((iceCandidate) => {
                    pc.addIceCandidate(iceCandidate);
                });
            }, this.onError);
    };

    handleRoomChange(event) {
        this.setState({...this.state, room: event.target.value});
    }

    handleNameChange(event) {
        this.setState({...this.state, name: event.target.value});
    }

    handleSubmit(event) {
        event.preventDefault();
        console.log('submitting', this.state.name, this.state.room);
        this.setState({ ...this.state, status: 'connect', info: 'Connecting' });
        this.socket.send(msg('joinRoom', { user: this.state.name, room: this.state.room, dataChannels: true }));
    }

    handleLeave(event) {
        this.socket.send(msg('leaveRoom'));
        this.setState({ ...this.state, connected: false });
        window.location.reload();
    }

    renderRemoteList = (list) => {
        return (
            Object.keys(list).map((peerId) => {
                console.log('remoteList item', peerId, 'url', list[peerId]);
                return <div key={peerId} className="video-wrapper">
                    <video autoPlay src={list[peerId]} className="remote-view"></video></div>;
            })
        );
    };

    render() {
        return (
            <div className="App">
                <header className="App-header">
                    <img src={logo} className="App-logo" alt="logo"/>
                    <h1 className="App-title">Huento</h1>
                </header>
                <p className="App-intro">
                    {this.state.info}
                </p>
                <video id="video" autoPlay src={this.state.selfViewSrc} className="self-view"></video>
                {this.state.connected ?
                    <div>
                        <button onClick={this.handleLeave}>Leave</button>
                        {this.renderRemoteList(this.state.remoteList)}
                    </div>
                    :
                    <form onSubmit={this.handleSubmit}>
                        <label>
                            Room:
                            <input type="text" value={this.state.room} onChange={this.handleRoomChange}/>
                        </label>
                        <label>
                            Name:
                            <input type="text" value={this.state.name} onChange={this.handleNameChange}/>
                        </label>
                        <input type="submit" value="Enter"/>
                    </form>
                }
            </div>
        );
    }
}

export default App;
