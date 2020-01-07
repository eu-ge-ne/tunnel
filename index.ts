import { promisify } from "util";

import { EventEmitter } from "events";
import { Socket } from "net";

import { Client, ClientChannel, TcpConnectionDetails, ClientErrorExtensions } from "ssh2";

const PORT_DEFAULT = 22;
const CONNECT_TIMEOUT_DEFAULT = 30_000;
const KEEPALIVE_INTERVAL_DEFAULT = 10_000;
const CHECK_INTERVAL_DEFAULT = 10_000;

export type Options = {
    /** Hostname or IP address of the server */
    host: string;
    /** SSH port of the server. Default = 22 */
    port?: number;
    /** SSH Username for authentication */
    username?: string;
    /** Password for password-based user authentication */
    password?: string;
    /** Buffer or string that contains a private key for either key-based or hostbased user authentication (OpenSSH format) */
    privateKey?: Buffer | string;
    /** The remote addr to bind on the server */
    remoteHost: string;
    /** The remote port to bind on the server */
    remotePort: number;
    /** The local addr to bind */
    localHost: string;
    /** The local port to bind */
    localPort: number;
    /** How long (in milliseconds) to wait for connection */
    connectTimeout?: number;
    /** How often (in milliseconds) to send SSH-level keepalive packets to the server. Set to 0 to disable */
    keepaliveInterval?: number;
    /** How often (in milliseconds) to check state of the tunnel and reconnect if disconnected */
    checkInterval?: number;
};

export type Status = {
    /** State of the tunnel */
    state: keyof typeof State;
    /** How many times disconnect occurred */
    disconnects: number;
    /** Number of active connections */
    connections: number;
}

enum State {
    Stopped,
    Disconnected,
    Disconnecting,
    Connecting,
    Connected,
}

type Connection = {
    local?: Socket;
    remote?: ClientChannel;
    timeout?: NodeJS.Timeout;
}

type Events = {
    /** Emitted on every tunnel state chane */
    state: (state: keyof typeof State) => void;
    /** Emitted on remote socket end */
    end: () => void;
    /** Emitted on remote socket close */
    close: (hadError: boolean) => void;
    /** Emitted on remote socket timeout */
    timeout: () => void;
    /** Emitted when any error occurs */
    error: (message: string, data?: { err: Error }) => void;
}

export declare interface Tunnel {
    on<E extends keyof Events>(event: E, listener: Events[E]): this;
    emit<E extends keyof Events>(event: E, ...args: Parameters<Events[E]>): boolean;
}

export class Tunnel extends EventEmitter {
    private client: Client;
    private checkTimeout!: NodeJS.Timeout;
    private state = State.Stopped;
    private disconnects = 0;
    private connections: Connection[] = [];

    public constructor(private options: Options) {
        super();

        this.client = new Client();

        this.client.on("ready", this.onReady.bind(this));
        this.client.on("tcp connection", this.onTcpConnection.bind(this));
        this.client.on("end", this.onEnd.bind(this));
        this.client.on("close", this.onClose.bind(this));
        this.client.on("timeout", this.onTimeout.bind(this));
        this.client.on("error", this.onError.bind(this));
    }

    public async start() {
        if (!this.canStart) {
            return;
        }

        this.changeStateAndNotify(State.Disconnected);

        this.onCheck();
        this.checkTimeout = setInterval(() => this.onCheck(), this.options.checkInterval ?? CHECK_INTERVAL_DEFAULT);

        let resolve: () => void;
        let reject: (reason: string) => void;

        const timeout = this.options.connectTimeout ?? CONNECT_TIMEOUT_DEFAULT;
        const timeoutAt = Date.now() + timeout;

        const interval = setInterval(() => {
            if (this.isConnected) {
                clearInterval(interval);
                resolve();
            }

            if (Date.now() >= timeoutAt) {
                clearInterval(interval);
                reject(`Start timeout ${timeout}`);
            }
        }, 500);

        return new Promise<void>((res, rej) => {
            resolve = res;
            reject = rej;
        });
    }

    public async stop() {
        if (!this.canStop) {
            return;
        }

        clearInterval(this.checkTimeout);

        await this.disconnect(false);

        this.changeStateAndNotify(State.Stopped);
    }

    public status(): Status {
        return {
            state: State[this.state] as keyof typeof State,
            disconnects: this.disconnects,
            connections: this.connections.length,
        };
    }

    private changeStateAndNotify(state: State) {
        this.state = state;
        this.emit("state", State[this.state] as keyof typeof State);
    }

    private get canStart() {
        return this.state === State.Stopped;
    }

    private get canStop() {
        return this.state !== State.Stopped;
    }

    private get shouldConnect() {
        return this.state === State.Disconnected;
    }

    private get isConnected() {
        return this.state === State.Connected;
    }

    private get canDisconnect() {
        return this.state > State.Disconnecting;
    }

    private onCheck() {
        if (this.shouldConnect) {
            this.changeStateAndNotify(State.Connecting);

            this.client.connect({
                host: this.options.host,
                port: this.options.port ?? PORT_DEFAULT,
                username: this.options.username,
                password: this.options.password,
                privateKey: this.options.privateKey,
                keepaliveInterval: this.options.keepaliveInterval ?? KEEPALIVE_INTERVAL_DEFAULT,
                readyTimeout: this.options.connectTimeout,
            });
        }
    }

    private destroyConnection(con: Connection) {
        if (con.timeout) {
            clearTimeout(con.timeout);
        }

        con.local?.unpipe();
        con.remote?.unpipe();

        con.local?.end();
        con.remote?.end();

        con.local?.removeAllListeners();
        con.remote?.removeAllListeners();

        const i = this.connections.indexOf(con);
        if (i >= 0) {
            this.connections.splice(i, 1);
        }
    }

    private async disconnect(silent = true) {
        if (!this.canDisconnect) {
            return;
        }

        this.changeStateAndNotify(State.Disconnecting);

        this.disconnects += 1;

        try {
            await promisify(this.client.unforwardIn).bind(this.client)(this.options.remoteHost, this.options.remotePort);
        } catch (err) {
            if (!silent) {
                this.emit("error", "Unforward error", { err });
            }
        }

        for (const conn of this.connections) {
            this.destroyConnection(conn);
        }

        this.client.end();

        this.changeStateAndNotify(State.Disconnected);
    }

    private onReady() {
        this.client.forwardIn(this.options.remoteHost, this.options.remotePort, (err, port) => {
            if (err) {
                this.emit("error", "Forward error", { err });
                this.disconnect();
                return;
            }
            this.changeStateAndNotify(State.Connected);
        });
    }

    private onTcpConnection(_details: TcpConnectionDetails, accept: () => ClientChannel, reject: () => void) {
        if (!this.isConnected) {
            return;
        }

        const con: Connection = {};
        this.connections.push(con);

        const local = con.local = new Socket();

        local.on("error", err => {
            this.emit("error", "Local socket error", { err });
            if (!con.remote) {
                reject();
            }
            this.destroyConnection(con);
        });

        local.connect(this.options.localPort, this.options.localHost, () => {
            const remote = con.remote = accept();

            remote.on("error", (err: Error) => {
                this.emit("error", "Remote socket error", { err });
                this.destroyConnection(con);
            });

            local.once("close", () => this.destroyConnection(con));
            remote.once("close", () => this.destroyConnection(con));

            local.pipe(remote).pipe(local);
        });
    }

    private onEnd() {
        this.emit("end");
        this.disconnect();
    }

    private onClose(hadError: boolean) {
        this.emit("close", hadError);
        this.disconnect();
    }

    private onTimeout() {
        this.emit("timeout");
        this.disconnect();
    }

    private onError(err: Error & ClientErrorExtensions) {
        this.emit("error", "Error", { err });
        this.disconnect();
    }
}
