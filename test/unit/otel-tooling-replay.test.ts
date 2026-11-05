import type { Span } from '@opentelemetry/api'
import type { ReadableSpan } from '@opentelemetry/sdk-trace'
import type { TraceEvent } from '../../packages/next/src/trace/types'

// Real dev/build behavior is covered by test/e2e/app-dir/otel-tooling.
// Keep only safety conditions that cannot be reliably induced in that fixture.
describe('tooling OTel safety', () => {
  const previousGate = process.env.NEXT_EXPERIMENTAL_OTEL_TOOLING
  let api: typeof import('@opentelemetry/api')
  let sdk: typeof import('@opentelemetry/sdk-trace')
  let backend: typeof import('../../packages/next/src/trace/otel')
  let reporting: typeof import('../../packages/next/src/trace/otel-reporting')
  let tracer: ReturnType<
    typeof import('next/dist/server/lib/trace/tracer').getTracer
  >
  let types: typeof import('next/dist/server/lib/trace/constants')
  let local: TraceEvent[]
  let exported: ReadableSpan[]

  beforeEach(() => {
    jest.resetModules()
    process.env.NEXT_EXPERIMENTAL_OTEL_TOOLING = '1'
    api = require('next/dist/compiled/@opentelemetry/api')
    api.trace.disable()
    local = []
    exported = []
    jest.doMock('../../packages/next/src/trace/report', () => ({
      reporter: { report: (event: TraceEvent) => local.push(event) },
    }))
    sdk = require('@opentelemetry/sdk-trace')
    backend = require('../../packages/next/src/trace/otel')
    reporting = require('../../packages/next/src/trace/otel-reporting')
    tracer =
      require('../../packages/next/src/server/lib/trace/tracer').getTracer()
    types = require('../../packages/next/src/server/lib/trace/constants')
  })

  afterEach(async () => {
    await backend.flushReporting()
    if (previousGate === undefined)
      delete process.env.NEXT_EXPERIMENTAL_OTEL_TOOLING
    else process.env.NEXT_EXPERIMENTAL_OTEL_TOOLING = previousGate
    jest.dontMock('../../packages/next/src/trace/report')
    api.trace.disable()
    api.context.disable()
    jest.restoreAllMocks()
    jest.useRealTimers()
  })

  function installProvider(onStart = () => {}) {
    expect(
      api.trace.setGlobalTracerProvider(
        new sdk.TracerProvider({
          spanProcessors: [
            {
              onStart,
              onEnd: (span) => exported.push(span),
              async forceFlush() {},
              async shutdown() {},
            },
          ],
        })
      )
    ).toBe(true)
  }

  function child(name: string, parent?: Span) {
    return tracer.startSpan(types.ToolingSpan.runWebpackCompiler, {
      spanName: name,
      parent,
    })
  }

  it.each(['count', 'bytes'])(
    'bounds retained %s without losing local records or the root',
    async (limit) => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      const count = limit === 'count' ? reporting.REPLAY_EVENT_LIMIT : 1
      const name =
        limit === 'bytes'
          ? '界'.repeat(reporting.REPLAY_BYTE_LIMIT / 2)
          : 'ordinary'
      for (let i = 0; i < count; i++) child(name).end()
      // Even a root captured after saturation has reserved admission capacity.
      tracer.startSpan(types.ToolingSpan.nextBuild, {}).end()
      expect(local).toHaveLength(count + 1)
      installProvider()
      backend.enableReporting()
      await backend.flushReporting()
      expect(exported).toHaveLength(
        limit === 'count' ? reporting.REPLAY_EVENT_LIMIT : 1
      )
      expect(exported.some((span) => span.name === 'next-build')).toBe(true)
      expect(warn).toHaveBeenCalledTimes(1)
    }
  )

  it('keeps local diagnostics when application SDK callbacks throw', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    installProvider(() => {
      throw new Error('application processor failure')
    })
    const root = tracer.startSpan(types.ToolingSpan.nextBuild, {})
    backend.enableReporting()
    expect(() => child('child', root).end()).not.toThrow()
    expect(() => root.end()).not.toThrow()
    await backend.flushReporting()
    expect(local.map((span) => span.name)).toEqual(['child', 'next-build'])
    expect(exported).toHaveLength(0)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('finishes reentrant SDK work without recursive entry or duplicate completion', () => {
    const root = tracer.startSpan(types.ToolingSpan.nextBuild, {})
    let inside = false
    let recursive = false
    const starts = jest.fn(() => {
      recursive ||= inside
      inside = true
      if (starts.mock.calls.length === 1) {
        root.end()
        child('child', root).end()
      }
      inside = false
    })
    installProvider(starts)
    backend.enableReporting()
    expect(recursive).toBe(false)
    expect(starts).toHaveBeenCalledTimes(2)
    expect(local.map((span) => span.name)).toEqual(['next-build', 'child'])
    expect(exported.map((span) => span.name)).toEqual(['next-build', 'child'])
    expect(exported[1].parentSpanContext?.spanId).toBe(
      exported[0].spanContext().spanId
    )
  })

  it('bounds a hanging flush hook and clears its timeout', async () => {
    jest.useFakeTimers()
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    backend.enableReporting(() => new Promise(() => {}))
    const flush = backend.flushReporting()
    await jest.advanceTimersByTimeAsync(reporting.FLUSH_TIMEOUT_MS)
    await expect(flush).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(jest.getTimerCount()).toBe(0)
  })
})
