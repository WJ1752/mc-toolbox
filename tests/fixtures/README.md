# 测试用自签证书

`friends-test-cert.pem` / `friends-test-key.pem` 只用于 `tests/friends-client.test.mjs`：
在 127.0.0.1 上起一个 HTTPS 好友服务器，验证客户端的证书指纹探测、固定与不匹配拒绝。

- 自签、仅含 `DNS:localhost, IP:127.0.0.1`，不用于任何真实服务器。
- 私钥公开在仓库里是刻意的，没有保密价值；生产证书由部署脚本在服务器上单独生成。
