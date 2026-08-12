import { createProxyServer } from "../fallback-proxy-lib"

export default async ({ client }) => {
  const server = createProxyServer({
    log: (msg) =>
      void client.app.log({
        body: { service: "fallback-proxy", level: "warn", message: msg },
      }),
    // A silent downgrade is still a downgrade: the log lands in the server file
    // nobody reads mid-session, so the one event worth interrupting for — the
    // answer came from a model you did not ask for — goes to the TUI instead.
    onSwap: (requested, served) =>
      void client.tui.showToast({
        body: {
          title: "fallback-proxy",
          message: `${requested} no disponible — respondiendo con ${served}`,
          variant: "warning",
        },
      }),
  })

  return {
    config(cfg) {
      cfg.provider = cfg.provider ?? {}
      for (const [provider, tier] of Object.entries({ opencode: "zen", "opencode-go": "go" } as const)) {
        cfg.provider[provider] ??= {}
        cfg.provider[provider]!.options ??= {}
        cfg.provider[provider]!.options.baseURL = `http://127.0.0.1:${server.port}/${tier}`
      }
    },
    dispose() {
      // Forced: a plugin reload must not be held open by an in-flight generation.
      server.stop(true)
    },
  }
}
