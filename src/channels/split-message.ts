/**
 * Split a message into chunks that fit within the given max length.
 * Prefers splitting at double newlines (paragraphs), then single newlines,
 * then spaces, and finally hard-cuts as a last resort.
 */
export function splitMessage(text: string, maxLength: number): string[] {
	if (text.length <= maxLength) return [text]

	const chunks: string[] = []
	let remaining = text

	while (remaining.length > 0) {
		if (remaining.length <= maxLength) {
			chunks.push(remaining)
			break
		}

		const slice = remaining.slice(0, maxLength)
		let splitAt = -1

		// Try splitting at last double newline (paragraph boundary)
		const doubleNewline = slice.lastIndexOf("\n\n")
		if (doubleNewline > maxLength * 0.3) {
			splitAt = doubleNewline
		}

		// Try splitting at last single newline
		if (splitAt === -1) {
			const singleNewline = slice.lastIndexOf("\n")
			if (singleNewline > maxLength * 0.3) {
				splitAt = singleNewline
			}
		}

		// Try splitting at last space
		if (splitAt === -1) {
			const space = slice.lastIndexOf(" ")
			if (space > maxLength * 0.3) {
				splitAt = space
			}
		}

		// Hard cut as last resort
		if (splitAt === -1) {
			splitAt = maxLength
		}

		chunks.push(remaining.slice(0, splitAt))
		remaining = remaining.slice(splitAt).replace(/^[\s]+/, "")
	}

	return chunks
}
