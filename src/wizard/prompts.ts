export type WizardSelectOption<T = string> = { value: T; label: string; hint?: string }

export type WizardSelectParams<T = string> = {
	message: string
	options: Array<WizardSelectOption<T>>
	initialValue?: T
}

export type WizardTextParams = {
	message: string
	initialValue?: string
	placeholder?: string
	validate?: (value: string) => string | undefined
}

export type WizardConfirmParams = {
	message: string
	initialValue?: boolean
}

export type WizardPrompter = {
	intro: (title: string) => Promise<void>
	outro: (message: string) => Promise<void>
	note: (message: string, title?: string) => Promise<void>
	select: <T>(params: WizardSelectParams<T>) => Promise<T>
	text: (params: WizardTextParams) => Promise<string>
	confirm: (params: WizardConfirmParams) => Promise<boolean>
}

export class WizardCancelledError extends Error {
	constructor() {
		super("Wizard cancelled by user")
		this.name = "WizardCancelledError"
	}
}
