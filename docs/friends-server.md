# 好友服务器（自建，中心式）

启动器的好友系统需要一台自建服务器：正版 MC 账号登录、好友关系、在线状态、离线聊天与临时文件中转都在这里。服务端是单文件、零依赖的 `tools/friends-server.mjs`，一台 1 核 1G 的轻量服务器就够用。

> v1.10.0 的 P2P 好友码/中转方案已在 v1.11.0 移除；这份文档只描述当前的服务器模式。

## 1. 它保存什么

| 数据 | 位置 | 保留 |
| --- | --- | --- |
| 账户、好友、请求、已读位置、活动 | `accounts.json` | 长期 |
| 会话令牌哈希 | `sessions.json` | 30 天 |
| 聊天 | `messages/<a>_<b>.jsonl` | 长期 |
| 模组清单 | `mods/<uuid>.json` | 长期 |
| 整合包 / 模组文件 | `files/<id>.bin` | 下载后 10 分钟删除；未下载 24 小时过期 |

配额默认 **5 GB/账号**、**15 GB 全局**，可用 `--quota-mb`、`--global-mb` 调整。文件不会被长期保存。

## 2. 身份与安全

- 客户端把启动器已登录的 **正版 Minecraft 访问令牌** 发给服务器；服务器调用 Mojang `minecraft/profile` 校验后拿到 UUID 与正版 ID。访问令牌只用于这一次校验，不写盘。
- 服务器发 30 天随机会话令牌，只存 SHA-256 哈希。
- 注册默认需要邀请码（`--invite` 或环境变量 `MCTB_FRIENDS_INVITE`）；已注册账户再次登录不需要。
- 服务器默认 HTTPS，使用自签证书；客户端内置证书 SHA-256 指纹并在每次响应时比对，换证书必须改配置重新发版。
- 公网 `http://` 在客户端直接拒绝（仅允许 localhost 测试）。
- 服务器磁盘上的聊天/文件对管理员可见；介意隐私就不要用中心服务器模式，或给数据目录做加密与定期清理。

## 3. 部署（Ubuntu 24.04 示例）

```bash
# 1) Node.js 18+
apt-get update && apt-get install -y nodejs
node -v

# 2) 上传程序
mkdir -p /opt/mc-toolbox
scp tools/friends-server.mjs root@<服务器>:/opt/mc-toolbox/
```

### 3.1 自签证书

```bash
mkdir -p /etc/mctb-friends
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout /etc/mctb-friends/key.pem -out /etc/mctb-friends/cert.pem \
  -days 3650 -subj "/CN=mc-toolbox-friends" \
  -addext "subjectAltName=IP:<公网 IP>,DNS:localhost,IP:127.0.0.1"
chmod 600 /etc/mctb-friends/key.pem /etc/mctb-friends/cert.pem
openssl x509 -in /etc/mctb-friends/cert.pem -noout -fingerprint -sha256
```

最后一行用于核对/更新客户端内置指纹（`src/server/friends/config.js`）。

### 3.2 用户、邀请码与数据目录

```bash
groupadd --system mctb-friends
useradd --system --home-dir /var/lib/mc-toolbox-friends \
  --shell /usr/sbin/nologin --gid mctb-friends mctb-friends
mkdir -p /var/lib/mc-toolbox-friends
chown -R mctb-friends:mctb-friends /var/lib/mc-toolbox-friends

printf 'MCTB_FRIENDS_INVITE=%s\n' "$(openssl rand -hex 6)" > /etc/mctb-friends/invite.env
chmod 600 /etc/mctb-friends/invite.env
cat /etc/mctb-friends/invite.env   # 把邀请码发给朋友
```

### 3.3 systemd

```ini
# /etc/systemd/system/mc-toolbox-friends.service
[Unit]
Description=MC Toolbox friends server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=mctb-friends
Group=mctb-friends
EnvironmentFile=/etc/mctb-friends/invite.env
ExecStart=/usr/bin/node /opt/mc-toolbox/friends-server.mjs --port=443 --host=0.0.0.0 \
  --cert=/etc/mctb-friends/cert.pem --key=/etc/mctb-friends/key.pem \
  --data=/var/lib/mc-toolbox-friends
# 443 是特权端口：只给绑定能力，不用 root 运行
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/mc-toolbox-friends
LimitNOFILE=65536
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now mc-toolbox-friends
systemctl status mc-toolbox-friends
journalctl -u mc-toolbox-friends -f
```

证书私钥如果放在 `/etc/mctb-friends`，把该目录设为 `root:mctb-friends`、`key.pem` 640，或按上面用 `--cert/--key` 指向可读位置。

### 3.4 云防火墙

在阿里云/腾讯云控制台放行 **TCP 443**。如果 443 已被网站占用，可改用 `--port 8443` 并在控制台放行 8443；客户端地址写成 `https://<IP>:8443`。

## 4. 客户端

发布版把服务器地址与证书指纹内置在 `src/server/friends/config.js`，好友页只显示「官方服务器（内置）」，玩家不能修改，也不显示地址/指纹。

1. 在启动器里登录正版微软账户（离线/第三方账户会被拒绝）。
2. 好友 → 填邀请码 → 「绑定正版账号并登录」。
3. 把邀请码发给朋友；双方按正版游戏 ID 互加好友。

自建/本地调试时，可在启动前设置 `MC_TOOLBOX_FRIENDS_SERVER`、`MC_TOOLBOX_FRIENDS_FINGERPRINT` 环境变量临时覆盖；正式发布应改 `config.js` 并重新构建，换证书/换地址都必须重新发版。

## 5. 接口

所有接口在 HTTPS 下，除 `/api/health` 与 `/api/auth/minecraft` 外都需要 `Authorization: Bearer <会话令牌>`：

- `GET /api/health`（版本、是否需邀请码、配额）
- `POST /api/auth/minecraft`（MC 访问令牌 + 可选邀请码 → 会话）
- `GET /api/friends`、`POST /api/friends/request`、`POST /api/friends/respond`、`DELETE /api/friends/:uuid`
- `GET|POST /api/messages`、`POST /api/read`
- `POST /api/files`、`PUT /api/files/:id`、`GET /api/files`、`GET /api/files/:id/download`、`DELETE /api/files/:id`
- `PUT /api/mods/:key`、`GET /api/mods?uuid=`
- `PUT /api/me`、`POST /api/heartbeat`、`POST /api/auth/logout`

## 6. 备份与排障

```bash
# 备份（停止服务或低峰期执行）
systemctl stop mc-toolbox-friends
tar czf /root/mctb-friends-$(date +%F).tgz -C /var/lib mc-toolbox-friends
systemctl start mc-toolbox-friends

# 看日志 / 端口 / 证书
journalctl -u mc-toolbox-friends -n 100 --no-pager
ss -lntp | grep 443
openssl x509 -in /etc/mctb-friends/cert.pem -noout -fingerprint -sha256
```

| 现象 | 检查 |
| --- | --- |
| 客户端检测失败 | 控制台防火墙 443；`systemctl status`；证书路径与权限 |
| 指纹不匹配 | 服务器是否换了证书；更新内置证书指纹并重新发版 |
| 登录提示邀请码 | 注册需要 `MCTB_FRIENDS_INVITE`；已注册账户不需要 |
| 登录提示非正版 | 启动器账户必须是微软正版；离线/第三方无法校验 |
| 上传提示配额满 | 等待好友下载或 24 小时过期；调整 `--quota-mb` / `--global-mb` |
| 文件已清理 | 下载完成后 10 分钟删除，需重新发送 |

## 7. 验证

仓库测试：

- `tests/friends-server.test.mjs`：MC 校验、邀请码、好友、离线聊天、文件生命周期与配额、模组清单权限、会话失效。
- `tests/friends-client.test.mjs`：自签证书指纹探测/固定、指纹不匹配拒绝、公网 HTTP 拒绝、HTTPS 登录与文件上传下载。

真实环境：Ubuntu 24.04 + Node 18.19，systemd 运行在 443，公网探测证书指纹与健康检查一致；临时文件上下行由本地 HTTPS 集成用例覆盖。
