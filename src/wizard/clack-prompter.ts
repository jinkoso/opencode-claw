import { cancel, confirm, intro, isCancel, note, outro, select, text } from "@clack/prompts"
import type {
	WizardConfirmParams,
	WizardPrompter,
	WizardSelectParams,
	WizardTextParams,
} from "./prompts.js"
import { WizardCancelledError } from "./prompts.js"

function guardCancel<T>(value: T | symbol): T {
	if (isCancel(value)) {
		cancel("Setup cancelled.")
		throw new WizardCancelledError()
	}
	return value
}

export function createClackPrompter(): WizardPrompter {
	return {
		async intro(title: string): Promise<void> {
			intro(title)
		},

		async outro(message: string): Promise<void> {
			outro(message)
		},

		async note(message: string, title?: string): Promise<void> {
			note(message, title)
		},

		async select<T>(params: WizardSelectParams<T>): Promise<T> {
			const result = await select<T>({
				message: params.message,
				options: params.options as Parameters<typeof select<T>>[0]["options"],
				initialValue: params.initialValue,
			})
			return guardCancel(result)
		},

		async text(params: WizardTextParams): Promise<string> {
			const result = await text({
				message: params.message,
				initialValue: params.initialValue,
				placeholder: params.placeholder,
				validate: params.validate
					? (value) => {
							const fn = params.validate
							if (!fn) return undefined
							return fn(value ?? "")
						}
					: undefined,
			})
			return guardCancel(result)
		},

		async confirm(params: WizardConfirmParams): Promise<boolean> {
			const result = await confirm({
				message: params.message,
				initialValue: params.initialValue,
			})
			return guardCancel(result)
		},
	}
}
