export type ChannelId = "slack" | "telegram" | "whatsapp"

export type ChannelStatus = "connected" | "disconnected" | "connecting" | "error"

export type InboundMessage = {
	channel: ChannelId
	peerId: string
	peerName?: string
	groupId?: string
	threadId?: string
	text: string
	mediaUrl?: string
	replyToId?: string
	raw: unknown
}

export type OutboundMessage = {
	text: string
	threadId?: string
	replyToId?: string
}

export type InboundMessageHandler = (msg: InboundMessage) => Promise<void>

export type ChannelAdapter = {
	readonly id: ChannelId
	readonly name: string
	start(handler: InboundMessageHandler): Promise<void>
	stop(): Promise<void>
	send(peerId: string, message: OutboundMessage): Promise<void>
	sendTyping?(peerId: string): Promise<void>
	stopTyping?(peerId: string): Promise<void>
	status(): ChannelStatus
}
