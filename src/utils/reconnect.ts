import type { Logger } from "./logger.js"

type ReconnectOpts = {
	name: string
	connect: () => Promise<void>
	logger: Logger
	baseDelayMs?: number
	maxDelayMs?: number
	maxAttempts?: number
}

const DEFAULT_BASE_DELAY = 1000
const DEFAULT_MAX_DELAY = 30_000
const DEFAULT_MAX_ATTEMPTS = Number.POSITIVE_INFINITY

export function createReconnector(opts: ReconnectOpts) {
	const base = opts.baseDelayMs ?? DEFAULT_BASE_DELAY
	const cap = opts.maxDelayMs ?? DEFAULT_MAX_DELAY
	const limit = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS

	let attempts = 0
	let timer: ReturnType<typeof setTimeout> | null = null
	let stopped = false

	function delay(): number {
		const exponential = base * 2 ** attempts
		const jitter = Math.random() * base
		return Math.min(exponential + jitter, cap)
	}

	async function attempt(): Promise<void> {
		if (stopped) return
		attempts++

		if (attempts > limit) {
			opts.logger.error(`${opts.name}: max reconnect attempts (${limit}) reached, giving up`)
			return
		}

		const ms = delay()
		opts.logger.info(`${opts.name}: reconnecting in ${Math.round(ms)}ms (attempt ${attempts})`)

		timer = setTimeout(async () => {
			if (stopped) return
			try {
				await opts.connect()
				attempts = 0
				opts.logger.info(`${opts.name}: reconnected successfully`)
			} catch (err) {
				opts.logger.warn(`${opts.name}: reconnect failed`, {
					attempt: attempts,
					error: err instanceof Error ? err.message : String(err),
				})
				await attempt()
			}
		}, ms)
	}

	function reset(): void {
		attempts = 0
	}

	function stop(): void {
		stopped = true
		if (timer) {
			clearTimeout(timer)
			timer = null
		}
	}

	return { attempt, reset, stop }
}

export type Reconnector = ReturnType<typeof createReconnector>
