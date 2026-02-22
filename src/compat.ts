import { createWriteStream } from "node:fs"
import { readFile, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import type { Server } from "node:http"

export async function readTextFile(path: string): Promise<string> {
	return readFile(path, "utf-8")
}

export async function fileExists(path: string): Promise<boolean> {
	try {
		await stat(path)
		return true
	} catch {
		return false
	}
}

export async function readJsonFile<T>(path: string): Promise<T> {
	const text = await readFile(path, "utf-8")
	return JSON.parse(text) as T
}

export async function writeTextFile(path: string, content: string): Promise<void> {
	await writeFile(path, content, "utf-8")
}

export function createFileWriter(path: string): { write(data: string): void; flush(): void } {
	const stream = createWriteStream(path, { flags: "a", encoding: "utf-8" })
	return {
		write(data: string): void {
			stream.write(data)
		},
		flush(): void {},
	}
}

export function createHttpServer(
	port: number,
	handler: (req: Request) => Promise<Response>,
): { start(): void; stop(): void } {
	let srv: Server | null = null

	return {
		start(): void {
			srv = createServer((nodeReq, nodeRes) => {
				const host = nodeReq.headers.host ?? "localhost"
				const url = `http://${host}${nodeReq.url ?? "/"}`
				const request = new Request(url, {
					method: nodeReq.method ?? "GET",
					headers: nodeReq.headers as Record<string, string>,
				})

				handler(request)
					.then(async (response) => {
						const body = await response.text()
						nodeRes.writeHead(response.status, Object.fromEntries(response.headers))
						nodeRes.end(body)
					})
					.catch(() => {
						nodeRes.writeHead(500)
						nodeRes.end("Internal Server Error")
					})
			})

			srv.listen(port)
		},

		stop(): void {
			if (srv) {
				srv.close()
				srv = null
			}
		},
	}
}
