import { describe, expect, test } from "bun:test"
import { splitMessage } from "../../src/channels/split-message.js"

describe("splitMessage", () => {
	test("returns single chunk for short text", () => {
		const result = splitMessage("hello world", 100)
		expect(result).toEqual(["hello world"])
	})

	test("returns single chunk for text exactly at limit", () => {
		const text = "a".repeat(4096)
		const result = splitMessage(text, 4096)
		expect(result).toEqual([text])
	})

	test("splits at paragraph boundary (double newline)", () => {
		const paragraph1 = "a".repeat(40)
		const paragraph2 = "b".repeat(40)
		const text = `${paragraph1}\n\n${paragraph2}`
		const result = splitMessage(text, 60)
		expect(result).toEqual([paragraph1, paragraph2])
	})

	test("splits at single newline when no paragraph boundary", () => {
		const line1 = "a".repeat(40)
		const line2 = "b".repeat(40)
		const text = `${line1}\n${line2}`
		const result = splitMessage(text, 60)
		expect(result).toEqual([line1, line2])
	})

	test("splits at space when no newline available", () => {
		const word1 = "a".repeat(40)
		const word2 = "b".repeat(40)
		const text = `${word1} ${word2}`
		const result = splitMessage(text, 60)
		expect(result).toEqual([word1, word2])
	})

	test("hard cuts when no natural break point", () => {
		const text = "a".repeat(100)
		const result = splitMessage(text, 40)
		expect(result).toHaveLength(3)
		expect(result[0]).toBe("a".repeat(40))
		expect(result[1]).toBe("a".repeat(40))
		expect(result[2]).toBe("a".repeat(20))
	})

	test("handles empty string", () => {
		const result = splitMessage("", 100)
		expect(result).toEqual([""])
	})

	test("prefers paragraph boundary over newline", () => {
		const part1 = "line1\nline2"
		const part2 = "line3"
		const text = `${part1}\n\n${part2}`
		const result = splitMessage(text, 15)
		expect(result[0]).toBe(part1)
		expect(result[1]).toBe(part2)
	})

	test("strips leading newlines from remainder", () => {
		const text = "abc\n\n\ndef"
		const result = splitMessage(text, 5)
		expect(result).toEqual(["abc", "def"])
	})

	test("handles realistic Telegram limit", () => {
		const lines = Array.from({ length: 200 }, (_, i) => `Line ${i}: ${"-".repeat(30)}`)
		const text = lines.join("\n")
		const result = splitMessage(text, 4096)
		for (const chunk of result) {
			expect(chunk.length).toBeLessThanOrEqual(4096)
		}
		expect(result.join("\n")).toBe(text)
	})
})
