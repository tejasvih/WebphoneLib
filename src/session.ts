import { EventEmitter } from 'events';
import {
  Grammar,
  ReferClientContext,
  ReferServerContext
} from 'sip.js';

import { audioContext } from './audio-context';
import { InternalSession, SessionMedia } from './session-media';
import { SessionStats } from './session-stats';
import * as Time from './time';
import { IMedia, IRemoteIdentity } from './types';
import { WrappedInviteClientContext, WrappedInviteServerContext } from './ua';
import { closeStream } from './utils';


type ReferContext = ReferClientContext | ReferServerContext;


interface ISession {
  readonly id: string;
  readonly media: SessionMedia;
  readonly stats: SessionStats;

  on(event: 'statsUpdated', listener: () => void): this;
}


export class Session extends EventEmitter implements ISession {
  public readonly id;
  public readonly media;
  public readonly stats;
  public saidBye: boolean;
  public holdState: boolean;

  private session: InternalSession;

  private acceptedPromise: Promise<boolean>;
  private acceptPromise: Promise<void>;
  private rejectPromise: Promise<void>;
  private terminatedPromise: Promise<void>;
  private reinvitePromise: Promise<boolean>;

  private statsTimer: number = undefined;
  private statsInterval: number = 5 * Time.second;

  constructor({session, media}: {
    session: WrappedInviteClientContext | WrappedInviteServerContext,
    media: IMedia
  }) {
    super();
    this.session = (session as InternalSession);
    this.id = session.request.callId;
    this.media = new SessionMedia(this.session, media);
    this.stats = new SessionStats();

    this.acceptedPromise = new Promise(resolve => {
      const handlers = {
        onAccepted: () => {
          this.session.removeListener('rejected', handlers.onRejected);
          resolve(true);
        },
        onRejected: () => {
          this.session.removeListener('accepted', handlers.onAccepted);
          resolve(false);
        }
      };

      this.session.once('accepted', handlers.onAccepted);
      this.session.once('rejected', handlers.onRejected);
    });

    this.saidBye = false;

    this.terminatedPromise = new Promise((resolve, reject) => {
      this.session.once('terminated', (message, cause) => {
        this.emit('terminated', this);

        // Asterisk specific header that signals that the VoIP account used is not
        // configured for WebRTC.
        if (cause === 'BYE' && message.getHeader('X-Asterisk-Hangupcausecode') === '58') {
          reject(new Error('MisconfiguredAccount'));
        } else {
          resolve();
        }
      });
    });

    this.saidBye = false;
    this.session.once('bye', () => {
      this.saidBye = true;
    });

    this.holdState = false;

    // Set up stats timer to priodically query and process the peer connection's
    // statistics.
    this.session.once('SessionDescriptionHandler-created', () => {
      this.statsTimer = window.setInterval(() => {
        const pc = this.session.sessionDescriptionHandler.peerConnection;
        pc.getStats().then(stats => {
          if (this.stats.add(stats)) {
            this.emit('statsUpdated', this.stats);
          }
        });
      }, this.statsInterval);
    });

    this.session.once('terminated', () => {
      if (this.statsTimer) {
        window.clearInterval(this.statsTimer);
        delete this.statsTimer;
      }
    });
  }

  get remoteIdentity(): IRemoteIdentity {
    const request = this.session.request;
    let identity;
    ['P-Asserted-Identity', 'Remote-Party-Id', 'From'].some(header => {
      if (request.hasHeader(header)) {
        identity = Grammar.nameAddrHeaderParse(request.getHeader(header));
        return true;
      }
    });

    let phoneNumber = this.session.remoteIdentity.uri.user;
    let displayName: string;

    if (identity) {
      phoneNumber = identity.uri.normal.user;
      displayName = identity.displayName;
    }

    return { phoneNumber, displayName };
  }

  public accept(options: any = {}): Promise<void> {
    if (this.rejectPromise) {
      throw new Error('invalid operation: session is rejected');
    }

    if (this.acceptPromise) {
      return this.acceptPromise;
    }

    this.acceptPromise = new Promise((resolve, reject) => {
      const handlers = {
        onAnswered: () => {
          this.session.removeListener('failed', handlers.onFail);
          resolve();
        },
        onFail: e => {
          this.session.removeListener('accepted', handlers.onAnswered);
          reject(e);
        }
      };
      this.session.once('accepted', handlers.onAnswered);
      this.session.once('failed', handlers.onFail);

      this.session.accept(options);
    });

    return this.acceptPromise;
  }

  public reject(options: any = {}): Promise<void> {
    if (this.acceptPromise) {
      throw new Error('invalid operation: session is accepted');
    }

    if (this.rejectPromise) {
      return this.rejectPromise;
    }

    this.rejectPromise = new Promise(resolve => {
      this.session.once('rejected', () => resolve());
      // reject is immediate, it doesn't fail.
      this.session.reject(options);
    });

    return this.rejectPromise;
  }

  public accepted(): Promise<boolean> {
    return this.acceptedPromise;
  }

  public terminated(): Promise<void> {
    return this.terminatedPromise;
  }

  public terminate(options = {}): Promise<void> {
    this.session.terminate(options);
    return this.terminatedPromise;
  }

  public reinvite(): void {
    console.log('reinvite called!');
    this.session.reinvite();
  }

  public hold(): Promise<boolean> {
    return this.setHoldState(true);
  }

  public unhold(): Promise<boolean> {
    return this.setHoldState(false);
  }

  // In the case of a BLIND transfer, a string can be passed along with a
  // number.
  // In the case of an ATTENDED transfer, a NEW call(/session) should be
  // made. This NEW session (a.k.a. InviteClientContext/InviteServerContext
  // depending on whether it is outbound or inbound) should then be passed
  // to this function.
  public async transfer(target: Session | string): Promise<boolean> {
    const referRequestedPromise: Promise<ReferContext> = new Promise((resolve, rejected) =>
      this.session.once('referRequested', context => {
        console.log('refer is requested');
        resolve(context);
      })
    );

    // as string because we only implemented blind transfer for now
    this.session.refer(target as string);

    const referContext = await referRequestedPromise;

    return new Promise((resolve, rejected) => {
      referContext.once('referAccepted', () => {
        console.log('refer is accepted!');
        resolve(true);
      });
    });
  }

  /**
   * Reconfigure the WebRTC peerconnection.
   */
  public rebuildSessionDescriptionHandler() {
    this.session.rebuildSessionDescriptionHandler();
  }

  /**
   * Function this.session.bye triggers terminated, so nothing else has to be
   * done here.
   */
  public bye() {
    this.session.bye();
  }

  /**
   * Send one or more DTMF tones.
   * @param tones May only contain the characters `0-9A-D#*,`
   */
  public dtmf(tones: string): void {
    // Unfortunately there is no easy way to give feedback about the DTMF
    // tones. SIP.js uses one of two methods for sending the DTMF:
    //
    // 1. RTP (via the SDH)
    // Internally returns a `boolean` for the whole strong.
    //
    // 2. INFO (websocket)
    //
    // Sends one tone after the other where the timeout is determined by the kind
    // of tone send. If one tone fails, the entire sequence is cleared. There is
    // no feedback about the failure.
    this.session.dtmf(tones);
  }

  // public transfer() {}

  private getReinvitePromise(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const handlers = {
        onReinviteAccepted: e => {
          this.session.removeListener('reinviteFailed', handlers.onReinviteFailed);
          // Calling resolve after removeListener, otherwise, when it fails,
          // the resolved promise can not be rejected with an error trace
          // anymore.
          resolve(true);
        },
        onReinviteFailed: e => {
          this.session.removeListener('reinviteAccepted', handlers.onReinviteAccepted);
          // Calling reject after removeListener, otherwise, when it fails,
          // reject returns the wrong trace.
          reject(e);
        }
      };

      this.session.once('reinviteAccepted', handlers.onReinviteAccepted);
      this.session.once('reinviteFailed', handlers.onReinviteFailed);
    });
  }

  private setHoldState(flag) {
    if (this.holdState === flag) {
      return this.reinvitePromise;
    }

    this.reinvitePromise = this.getReinvitePromise();

    if (flag) {
      console.log('hold!');
      this.session.hold();
    } else {
      console.log('unhold!');
      this.session.unhold();
    }

    this.holdState = flag;

    return this.reinvitePromise;
  }
}
