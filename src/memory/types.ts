export type MemoryScope = "tenet" | "project" | "general"

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
	scope?: MemoryScope
	projectKey?: string
}

export type MemoryEntry = {
	id: string
	content: string
	category: MemoryCategory
	source: string
	createdAt: Date
	relevance?: number
	metadata?: Record<string, unknown>
	scope?: MemoryScope
	projectKey?: string
}

export type MemoryInput = {
	content: string
	category: MemoryCategory
	source: string
	metadata?: Record<string, unknown>
	scope?: MemoryScope
	projectKey?: string
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
	load(scope: MemoryScope, projectKey?: string): Promise<string>
	replace(scope: MemoryScope, projectKey: string | undefined, content: string): Promise<void>
	status(): Promise<MemoryStatus>
	close(): Promise<void>
}
