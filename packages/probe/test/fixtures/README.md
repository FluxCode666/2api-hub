# TLS 测试证书 fixture

`tlscert` / `tlskey`：自签证书（CN=localhost，SAN=localhost+127.0.0.1，2 天有效期），
供 `test/tls.test.ts` 的「自签证书必须失败」用例使用。

## 重建方法（过期后执行）

```bash
cd packages/probe/test/fixtures
openssl req -x509 -newkey rsa:2048 -keyout tlskey -out tlscert -days 2 -nodes \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```

注意：证书为测试专用，不含任何真实身份信息，可安全入库。
