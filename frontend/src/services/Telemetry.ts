import { Effect, Layer } from "effect"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http"
import { OtlpSerialization, OtlpTracer } from "effect/observability"
import { Ingest } from "@/wailsjs/go/rpc/Telemetry"

/**
 * An HttpClient that hands each OTLP export to the backend instead of the
 * network, so frontend spans join backend spans in one place and nothing
 * depends on the webview's network or content security policy.
 */
const ingestClient = HttpClient.make((request) =>
  Effect.tryPromise({
    try: async () => {
      const body = request.body
      if (body._tag !== "Uint8Array") {
        throw new Error(`unexpected telemetry body ${body._tag}`)
      }
      await Ingest(toBase64(body.body))
      return HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }))
    },
    catch: (cause) =>
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({ request, cause }),
      }),
  }),
)

const toBase64 = (bytes: Uint8Array): string => {
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

/** Exports every span created on the runtime to the backend. */
export const TelemetryLayer = OtlpTracer.layer({
  url: "forkit://telemetry",
  resource: { serviceName: "forkit-frontend" },
  exportInterval: "2 seconds",
}).pipe(
  Layer.provide(OtlpSerialization.layerProtobuf),
  Layer.provide(Layer.succeed(HttpClient.HttpClient, ingestClient)),
)
