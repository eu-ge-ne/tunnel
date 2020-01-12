@eu-ge-ne/tunnel
================

Reverse ssh tunnel

###### [Install](#Install) | [Example](#Example) | [Api](#Api) | [License](#License)

[![npm version](https://badge.fury.io/js/%40eu-ge-ne%2Ftunnel.svg)](https://badge.fury.io/js/%40eu-ge-ne%2Ftunnel)

Forwards traffic from public to local developer's machine.
Think of self-hosted alternative to ngrok, localtunnel etc, but without traffic limitations.

You will need public VPS with dns name.
Reverse dns from your hosting provider should serve the purpose as well.

Install
-------

```bash
$ npm install @eu-ge-ne/tunnel
```

Example
-------

Assuming you already have VPS with Ubuntu installed, with `<vps-dns-name>` dns name.

### Harden SSH Access

Disable password authentication for SSH logins and enable public key auth:

1. On local machine:

    ```bash
    ssh-keygen -b 4096
    ```

    File where keys will be saved: `id_rsa_proxy`
    **Leave passphrase blank.**

2. On VPS:

    ```bash
    mkdir -p ~/.ssh && sudo chmod -R 700 ~/.ssh/
    ```

3. From local machine copy public key (`id_rsa_proxy.pub`) to VPS:

    ```bash
    scp id_rsa_proxy.pub <user>@<vps-dns-name>:~/.ssh/authorized_keys
    ```

4. Set permissions for the public key directory and the key file itself:

    ```bash
    sudo chmod -R 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys
    ```

5. Set SSH daemon options (`/etc/ssh/sshd_config`):

    ```bash
    PermitRootLogin no
    PasswordAuthentication no
    ```

6. Restart the SSH service to load the new configuration:

    ```bash
    sudo systemctl restart sshd
    ```

### Install and configure NGINX

```bash
sudo apt update
sudo apt install nginx
```

`/etc/nginx/sites-available/default` example:

```nginx
server {
    server_name <vps-dns-name>;

    location / {
        proxy_pass http://127.0.0.1:8888/;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_redirect off;
    }

    error_page 500 502 503 504 /50x.html;
    location = /50x.html {
        root /usr/share/nginx/html;
    }
}
```

### Obtain TLS/SSL certificate from Let’s Encrypt

```bash
sudo add-apt-repository ppa:certbot/certbot
sudo apt install python-certbot-nginx
sudo certbot --nginx -d <vps-dns-name>
```

Final `/etc/nginx/sites-available/default` example:

```nginx
server {
    server_name <vps-dns-name>;

    location / {
        proxy_pass http://127.0.0.1:8888/;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_redirect off;
    }

    error_page 500 502 503 504 /50x.html;
    location = /50x.html {
        root /usr/share/nginx/html;
    }

    listen 443 ssl; # managed by Certbot
    ssl_certificate /etc/letsencrypt/live/<vps-dns-name>/fullchain.pem; # managed by Certbot
    ssl_certificate_key /etc/letsencrypt/live/<vps-dns-name>/privkey.pem; # managed by Certbot
    include /etc/letsencrypt/options-ssl-nginx.conf; # managed by Certbot
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem; # managed by Certbot
}

server {
    if ($host = <vps-dns-name>) {
        return 301 https://$host$request_uri;
    } # managed by Certbot

    server_name <vps-dns-name>;
    listen 80;
    return 404; # managed by Certbot
}
```

API
---

### Create instance

```typescript
import { Tunnel, Options } from "@eu-ge-ne/tunnel";

const options: Options = { /* ... */ };

const tunnel = new Tunnel(options);
```

Options declaration:

```typescript
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
```

### Start

```typescript
await tunnel.start();
```

### Stop

```typescript
await tunnel.stop();
```

### Get status

```typescript
import { Status } from "@eu-ge-ne/tunnel";

const status: Status = tunnel.status();
```

Status declaration:

```typescript
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
```

### Events

Events declaration:

```typescript
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
```

License
-------

[MIT](LICENSE)
