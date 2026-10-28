# Development

## Local Documentation Site {#local-documentation-site}

From the repository root, run `pnpm docs:dev` and open `http://127.0.0.1:4174/` in a browser. Run `pnpm docs:build` to generate the static manual, then use `pnpm docs:preview` to preview it on the same loopback port. If the port is occupied, the command exits. To verify a subpath, run `pnpm docs:build --base /pi-muse/`, then preview it with `pnpm docs:preview --base /pi-muse/`. This site reads only `docs/manual/`; it does not build engineering documents or historical records.

## Local Business Development {#local-business-development}

The server source watch entry point is `pnpm dev`. The repository's Web integration page is `pnpm --dir web dev`, which defaults to `http://localhost:15173`. For interactive debugging without credentials, `pnpm dev:mock` is available, but it uses a fake provider and cannot serve as business acceptance for the real backend and external model. For detailed procedures, see the [server development guide](https://github.com/yaotutu/pi-muse/blob/main/docs/development.md) and [testing guide](https://github.com/yaotutu/pi-muse/blob/main/docs/testing.md) on GitHub.

## APIs and Engineering Documents {#apis-and-engineering-documents}

A running server provides `/docs` and `/openapi.json`; these are the API references for HTTP/SSE clients. This site is the installation and usage manual and does not maintain a second API contract. For architecture and permission details, see the [architecture specification](https://github.com/yaotutu/pi-muse/blob/main/docs/architecture.md); for API development rules, see the [API development specification](https://github.com/yaotutu/pi-muse/blob/main/docs/api-development.md).
