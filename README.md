# SillyTavern Style-Bert Voice Picker

一个可通过 SillyTavern 的 **Install Extension** 安装的纯前端扩展。选中 AI 回复中的台词，指定 Style-Bert-VITS2 模型与说话人，即可在当前电脑或手机浏览器中合成并播放语音。

## 功能

- 桌面与手机页面兼容。
- 选中文字后显示浮动朗读按钮。
- AI 消息菜单中提供扬声器按钮，优先提取中文引号内的台词。
- 从 Style-Bert-VITS2 `/models/info` 自动读取模型、speaker 和 style。
- 使用 SillyTavern 当前配置的 LLM 自动选择模型实际存在的 style。
- 可手动调整 style、风格强度、语速、语言和辅助情绪文本。
- 长文本按标点切成不超过 100 字的片段，串行请求以降低显存压力。
- 当前页面会话内缓存最近 30 段音频。
- 多段音频顺序播放；手机禁止自动播放时保留原生音频控件。

## 要求

- 当前版本的 SillyTavern。
- [Style-Bert-VITS2 2.7.x](https://github.com/litagin02/Style-Bert-VITS2) API Server。
- 至少一个可被 Style-Bert-VITS2 发现的模型目录。
- 手机和运行 Style-Bert-VITS2 的电脑位于同一局域网。

## 安装

1. 在 SillyTavern 打开 `Extensions`。
2. 点击 `Install Extension`。
3. 粘贴本仓库的 Git URL。
4. 安装完成后刷新页面。
5. 在扩展设置中展开 **Style-Bert Voice Picker**。

## Style-Bert-VITS2 配置

启动 API Server：

```powershell
python server_fastapi.py
```

Style-Bert-VITS2 2.7.x 默认监听 `0.0.0.0:5000`。请检查 `config.yml`：

```yaml
server:
  port: 5000
  device: "cuda"
  language: "ZH"
  limit: 100
  origins:
    - "http://127.0.0.1:8000"
    - "http://localhost:8000"
    - "http://192.168.1.100:8000"
```

将示例中的 `192.168.1.100` 替换为运行 SillyTavern 和 Style-Bert-VITS2 的电脑局域网 IP。SillyTavern 端口也应按实际值修改。

Windows 防火墙需要允许 TCP 5000 端口的专用网络入站连接。不要把 5000 端口直接暴露到互联网；Style-Bert-VITS2 API 本身没有身份验证。

在浏览器访问以下地址可验证服务：

```text
http://127.0.0.1:5000/models/info
http://电脑局域网IP:5000/models/info
```

## 扩展设置

- **API 地址**：电脑使用 `http://127.0.0.1:5000`；手机应使用 `http://电脑局域网IP:5000`。如果手机和电脑共用同一个 SillyTavern 地址，扩展默认推导为 `http://当前酒馆主机:5000`。
- **默认模型 / 说话人 / 风格**：连接成功后从 API 自动加载。
- **默认语言**：稳定版支持 `ZH`、`JP` 和 `EN`。JP-Extra 模型只能使用 `JP`。
- **自动识别情绪**：合成前调用当前 SillyTavern LLM；关闭后直接使用手选 style。
- **辅助情绪文本**：可以增强情绪，但某些模型上可能损失韵律，可随时关闭。
- **单段字符数**：默认 90，上限 100，与 Style-Bert 默认限制匹配。

## 使用

### 选中文字

1. 在 AI 回复中选中一句或一段台词。
2. 点击选区附近出现的紫色扬声器按钮。
3. 确认音色和情绪，点击 **生成并播放**。

### 手机或整条消息

1. 打开 AI 消息的操作菜单。
2. 点击扬声器按钮。
3. 扩展会优先提取 `“……”`、`「……」`、`『……』` 中的内容；没有引号时使用整条消息。
4. 在弹窗中编辑台词后合成。

## 已知限制

- 这是纯前端扩展。为了做到一次 Git 安装，浏览器必须能直接访问 Style-Bert-VITS2 的 5000 端口。
- 如果 SillyTavern 页面使用 HTTPS，而 Style-Bert-VITS2 使用 HTTP，浏览器会因混合内容策略阻止请求。两者必须使用相同协议，或通过可信反向代理统一入口。
- CORS 不是访问控制。请使用 Windows 防火墙限制为可信局域网。
- Style-Bert-VITS2 的 POST `/voice` 仍使用 URL query 参数，这是上游 2.7.x API 的设计。
- 扩展只负责推理，不负责训练或下载角色模型。

## API 兼容性

本扩展按 Style-Bert-VITS2 `2.7.x` 的以下接口实现：

- `GET /models/info`
- `POST /models/refresh`
- `POST /voice?...`，成功响应为 `audio/wav`

未发布的 v3 开发分支目前只支持日语，不属于本版本的兼容目标。

## License

MIT
