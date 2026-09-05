# Packaging Public Verification Keys

此目录存放 OMP Studio 签名验证用的 **Ed25519 SPKI 公钥** 及多密钥信任表 `trusted-keys.json`。

## 安全约定

- **只放公钥（`.pem`）**：严禁将任何私钥（`BEGIN PRIVATE KEY`）放入此目录或提交到版本库中。
- **私钥保管**：生产私钥只保存在 GitHub Actions Release Environment Secret (`OMP_RUNTIME_SIGNING_KEY`) 中。
- **密钥轮换**：轮换密钥时，将新公钥加入 `trusted-keys.json` 的 `keys` 表中并随更新发布。
- **校验工具**：运行 `node scripts/release-keys.mjs verify` 校验公钥列表的完整性与安全性。
