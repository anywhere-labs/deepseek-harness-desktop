# DeepSeek Harness

English | [中文](README.zh.md)

DeepSeek Harness (`dsh`) is an open-source agent harness built by [DeepSeek AI](https://deepseek.com).

It uses an **everything-is-a-plugin** architecture driven by [Cordis](https://github.com/cordiverse/cordis), whose design follows the paper [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper).

## Developer preview

DeepSeek Harness is currently in _developer preview_ and iterating quickly. **Breaking changes will land.**

## Running

### Via `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

This starts the Web UI, by default at `http://127.0.0.1:3080`. See the [Web UI guide](docs/user/guide/index.md).

### From source

To run from the repository source:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

## Community and support

- Share feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Tag your plugin repository with the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to make it discoverable.
- Join the DeepSeek Harness WeCom group: scan to add the WeCom assistant and fill in the intake survey; the assistant then invites you to the group.

<table>
  <thead>
    <tr>
      <th align="center">WeCom assistant</th>
      <th align="center">Intake survey</th>
      <th align="center">WeChat official account</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><img src="assets/community-wecom-assistant.png" alt="DeepSeek Harness WeCom assistant QR code" width="180" height="180"></td>
      <td align="center"><a href="https://trtgsjkv6r.feishu.cn/share/base/form/shrcnIt5twSVdLGD52KJBckGCgg"><img src="assets/community-wecom-survey.png" alt="DeepSeek Harness intake survey QR code" width="180" height="180"></a></td>
      <td align="center"><img src="assets/community-wechat-official-account.png" alt="DeepSeek Harness team WeChat official account QR code" width="180" height="180"></td>
    </tr>
  </tbody>
</table>

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Read the [development guide](docs/development.md) and the [architecture document](docs/architecture.md) first.

For agents: follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
