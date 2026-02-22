import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import cron from "node-cron"
import type { CronConfig, CronJobConfig } from "../config/types.js"
import type { OutboxWriter } from "../outbox/writer.js"
import { promptStreaming } from "../sessions/prompt.js"
import type { Logger } from "../utils/logger.js"

type ScheduledJob = {
	config: CronJobConfig
	task: cron.ScheduledTask
}

type CronSchedulerDeps = {
	client: OpencodeClient
	outbox: OutboxWriter
	config: CronConfig
	logger: Logger
}

export function createCronScheduler(deps: CronSchedulerDeps) {
	const jobs = new Map<string, ScheduledJob>()
	const running = new Set<string>()

	async function executeJob(job: CronJobConfig): Promise<void> {
		if (running.has(job.id)) {
			deps.logger.warn(`cron: job "${job.id}" already running, skipping`)
			return
		}

		running.add(job.id)
		const title = `cron:${job.id}:${new Date().toISOString()}`

		deps.logger.info(`cron: firing job "${job.id}"`, { schedule: job.schedule })

		try {
			const session = await deps.client.session.create({
				title,
			})
			if (!session.data) throw new Error("session.create returned no data")

			const sessionId = session.data.id
			deps.logger.debug(`cron: job "${job.id}" session created`, { sessionId })

			const timeout = job.timeoutMs ?? deps.config.defaultTimeoutMs

			let text: string
			try {
				text = await promptStreaming(deps.client, sessionId, job.prompt, timeout, deps.logger)
			} catch (err) {
				if (err instanceof Error && err.message === "timeout") {
					deps.logger.warn(`cron: job "${job.id}" timed out after ${timeout}ms`)
					return
				}
				throw err
			}

			deps.logger.info(`cron: job "${job.id}" completed`, {
				sessionId,
				responseLength: text.length,
			})

			// Route result to channel if configured
			if (job.reportTo && text.trim()) {
				await deps.outbox.enqueue({
					channel: job.reportTo.channel,
					peerId: job.reportTo.peerId,
					text,
					threadId: job.reportTo.threadId,
				})
				deps.logger.info(
					`cron: job "${job.id}" result enqueued to ${job.reportTo.channel}:${job.reportTo.peerId}`,
				)
			}
		} catch (err) {
			deps.logger.error(`cron: job "${job.id}" failed`, {
				error: err instanceof Error ? err.message : String(err),
			})
		} finally {
			running.delete(job.id)
		}
	}

	function start(): void {
		if (!deps.config.enabled) {
			deps.logger.info("cron: disabled by config")
			return
		}

		for (const job of deps.config.jobs) {
			if (!job.enabled) {
				deps.logger.info(`cron: skipping disabled job "${job.id}"`)
				continue
			}

			if (!cron.validate(job.schedule)) {
				deps.logger.error(`cron: invalid schedule for job "${job.id}": ${job.schedule}`)
				continue
			}

			const task = cron.schedule(job.schedule, () => {
				executeJob(job).catch((err) => {
					deps.logger.error(`cron: unhandled error in job "${job.id}"`, {
						error: err instanceof Error ? err.message : String(err),
					})
				})
			})

			jobs.set(job.id, { config: job, task })
			deps.logger.info(`cron: scheduled "${job.id}" (${job.schedule}) — ${job.description}`)
		}

		deps.logger.info(`cron: ${jobs.size} job(s) scheduled`)
	}

	function stop(): void {
		for (const [id, { task }] of jobs) {
			task.stop()
			deps.logger.debug(`cron: stopped job "${id}"`)
		}
		jobs.clear()
		deps.logger.info("cron: all jobs stopped")
	}

	return { start, stop }
}

export type CronScheduler = ReturnType<typeof createCronScheduler>
