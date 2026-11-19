# 手机访问 / Mobile Access

## 中文

1. 让手机与电脑连接同一个 Wi‑Fi，保持 OMP Studio 桌面程序运行。
2. 在 **设置 → 手机访问** 选择要共享的本地项目和电脑的局域网地址，点击 **开启手机访问**。
3. 首次使用时，导出 `OMP-Studio-Mobile-CA.cer`，通过可信方式传到手机。核对桌面展示的 SHA‑256 指纹后，在 iOS 或 Android 的系统设置中安装并信任此证书。电脑地址变化或证书过期后需要更新手机上的证书。
4. 点击 **生成配对码**，在 60 秒内用手机扫码。打开一段已有会话即可查看消息、继续对话、停止当前回合或处理单次工具审批。

手机只访问开启时选定的本地项目。配对持续 8 小时，重新配对会替换原来的授权。需要提前结束时，在桌面选择 **撤销手机授权** 或 **关闭手机访问**。授权结束后，电脑上已在执行的任务继续运行。

页面已配对但显示 Runtime 尚未连通时，在手机尝试重新连接，或检查电脑能否打开同一会话。手机无法打开配对页面时，检查地址、防火墙、Wi‑Fi 是否允许设备互访，以及系统是否信任桌面导出的证书。

## English

1. Connect the phone and computer to the same Wi-Fi network and keep OMP Studio running on the computer.
2. In **Settings → Mobile access**, choose the local project and computer's LAN address, then choose **Enable mobile access**.
3. On first use, export `OMP-Studio-Mobile-CA.cer` and transfer it to the phone over a trusted channel. Verify the SHA‑256 fingerprint shown on the computer, then install and trust the certificate in iOS or Android system settings. Update the certificate on the phone if the computer address changes or the certificate expires.
4. Choose **Generate pairing code** and scan it within 60 seconds. Open an existing chat to read replies, continue the conversation, stop a turn, or handle a one-time tool approval.

The phone can access the local project selected at setup. Pairing lasts eight hours. Pairing a new browser replaces the previous browser's access. To end access early, choose **Revoke phone access** or **Disable mobile access** on the computer. Tasks already running continue on the computer.

If the page is paired but Runtime is unavailable, retry the connection or check whether the desktop app can open the same chat. If the phone cannot open the pairing page, check the address, firewall, whether the Wi-Fi allows devices to reach one another, and whether the phone trusts the exported certificate.
