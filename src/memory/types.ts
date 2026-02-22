export type MemoryCategory =
	| "project"
	| "experience"
	| "preference"
	| "entity"
	| "event"
	| "knowledge"

export type MemorySearchOptions = {
	limit?: number
	sessionId?: string
	category?: MemoryCategory
	minRelevance?: number
}

export type MemoryEntry = {
	id: string
	content: string
	category: MemoryCategory
	source: string
	createdAt: Date
	relevance?: number
	metadata?: Record<string, unknown>
}

export type MemoryInput = {
	content: string
	category: MemoryCategory
	source: string
	metadata?: Record<string, unknown>
}

export type MemoryStatus = {
	backend: string
	initialized: boolean
	entryCount: number
	lastSync?: Date
}

export type MemoryBackend = {
	initialize(): Promise<void>
	search(query: string, options?: MemorySearchOptions): Promise<MemoryEntry[]>
	store(entry: MemoryInput): Promise<void>
	delete(id: string): Promise<void>
	status(): Promise<MemoryStatus>
	close(): Promise<void>
}
