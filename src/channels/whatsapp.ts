import {
	type BaileysEventMap,
	DisconnectReason,
	type WASocket,
	makeWASocket,
	useMultiFileAuthState,
} from "@whiskeysockets/baileys"
import type { WhatsAppConfig } from "../config/types.js"
import type { Logger } from "../utils/logger.js"
import type {
	ChannelAdapter,
	ChannelStatus,
	InboundMessageHandler,
	OutboundMessage,
} from "./types.js"

type PendingMessage = {
	peerId: string
	texts: string[]
	timer: ReturnType<typeof setTimeout>
}

export function createWhatsAppAdapter(config: WhatsAppConfig, logger: Logger): ChannelAdapter {
	let state: ChannelStatus = "disconnected"
	let handler: InboundMessageHandler | undefined
	let sock: WASocket | undefined

	// Debounce map: peerId -> pending messages
	const pending = new Map<string, PendingMessage>()

	function extractPeerId(jid: string | null | undefined): string {
		if (!jid) return ""
		return jid.split("@")[0] ?? ""
	}

	function flush(peerId: string): void {
		const item = pending.get(peerId)
		if (!item || !handler) return
		pending.delete(peerId)

		const combined = item.texts.join("\n")
		if (!combined.trim()) return

		const msg = {
			channel: "whatsapp" as const,
			peerId: item.peerId,
			text: combined,
			raw: {},
		}

		handler(msg).catch((err) => {
			logger.error("whatsapp: handler error", {
				peerId,
				error: err instanceof Error ? err.message : String(err),
			})
		})
	}

	function debounce(peerId: string, text: string): void {
		const existing = pending.get(peerId)
		if (existing) {
			clearTimeout(existing.timer)
			existing.texts.push(text)
			existing.timer = setTimeout(() => flush(peerId), config.debounceMs)
		} else {
			const timer = setTimeout(() => flush(peerId), config.debounceMs)
			pending.set(peerId, { peerId, texts: [text], timer })
		}
	}

	async function connect(): Promise<void> {
		const { state: authState, saveCreds } = await useMultiFileAuthState(config.authDir)

		sock = makeWASocket({
			auth: authState,
			printQRInTerminal: true,
		})

		sock.ev.on("creds.update", saveCreds)

		sock.ev.on("connection.update", (update: BaileysEventMap["connection.update"]) => {
			const { connection, lastDisconnect } = update

			if (connection === "close") {
				const code = (
					lastDisconnect?.error as {
						output?: { statusCode?: number }
					}
				)?.output?.statusCode
				if (code !== DisconnectReason.loggedOut) {
					logger.warn("whatsapp: connection closed, reconnecting", {
						code,
					})
					state = "connecting"
					connect()
				} else {
					logger.error("whatsapp: logged out, not reconnecting")
					state = "disconnected"
				}
			}

			if (connection === "open") {
				state = "connected"
				logger.info("whatsapp: connected")
			}
		})

		sock.ev.on("messages.upsert", (upsert: BaileysEventMap["messages.upsert"]) => {
			if (upsert.type !== "notify") return

			for (const msg of upsert.messages) {
				if (msg.key.fromMe) continue

				const jid = msg.key.remoteJid
				const peerId = extractPeerId(jid)
				if (!peerId) continue

				// Allowlist check
				if (config.allowlist.length > 0 && !config.allowlist.includes(peerId)) {
					if (config.rejectionBehavior === "reject" && sock && jid) {
						sock
							.sendMessage(jid, {
								text: "This assistant is private.",
							})
							.catch(() => {})
					}
					logger.debug("whatsapp: message dropped (not in allowlist)", { peerId })
					continue
				}

				const text = msg.message?.conversation ?? msg.message?.extendedTextMessage?.text ?? ""
				if (!text) continue

				// Debounce rapid messages from same peer
				debounce(peerId, text)
			}
		})
	}

	return {
		id: "whatsapp",
		name: "WhatsApp",

		async start(h) {
			handler = h
			state = "connecting"
			logger.info("whatsapp: connecting...")
			await connect()
		},

		async stop() {
			// Flush all pending debounced messages
			for (const [peerId] of pending) {
				flush(peerId)
			}
			pending.clear()

			if (sock) {
				sock.end(undefined)
				sock = undefined
			}
			state = "disconnected"
			logger.info("whatsapp: disconnected")
		},

		async send(peerId, message: OutboundMessage) {
			if (!sock) throw new Error("WhatsApp socket not connected")
			const jid = `${peerId}@s.whatsapp.net`
			await sock.sendMessage(jid, { text: message.text })
		},
		async sendTyping(peerId) {
			if (!sock) return
			const jid = `${peerId}@s.whatsapp.net`
			await sock.sendPresenceUpdate("composing", jid)
		},

		async stopTyping(peerId) {
			if (!sock) return
			const jid = `${peerId}@s.whatsapp.net`
			await sock.sendPresenceUpdate("paused", jid)
		},

		status() {
			return state
		},
	}
}
