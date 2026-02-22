#!/usr/bin/env node
import { main } from "./index.js"

const args = process.argv.slice(2)

if (args.includes("--init")) {
	const { runOnboardingWizard } = await import("./wizard/onboarding.js")
	const { createClackPrompter } = await import("./wizard/clack-prompter.js")
	const { WizardCancelledError } = await import("./wizard/prompts.js")
	const prompter = createClackPrompter()
	try {
		await runOnboardingWizard(prompter)
	} catch (err) {
		if (err instanceof WizardCancelledError) {
			process.exit(1)
		}
		throw err
	}
} else {
	main().catch((err) => {
		console.error("Fatal:", err)
		process.exit(1)
	})
}
