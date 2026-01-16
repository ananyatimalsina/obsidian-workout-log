import { App, TFile } from 'obsidian';
import { SectionInfo } from '../types';

export class FileUpdater {
	private updateLocks = new Map<string, Promise<void>>();

	constructor(private app: App) {}

	// Serialize updates to the same file to prevent race conditions
	private async withLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
		// Wait for any pending update to complete
		const pending = this.updateLocks.get(filePath);
		if (pending) {
			await pending;
		}

		// Create a new promise for our update
		let resolve: () => void;
		const lock = new Promise<void>(r => { resolve = r; });
		this.updateLocks.set(filePath, lock);

		try {
			return await fn();
		} finally {
			resolve!();
			// Clean up if this is still our lock
			if (this.updateLocks.get(filePath) === lock) {
				this.updateLocks.delete(filePath);
			}
		}
	}

	async updateCodeBlock(
		sourcePath: string,
		sectionInfo: SectionInfo | null,
		newContent: string,
		expectedTitle?: string
	): Promise<boolean> {
		const file = this.app.vault.getAbstractFileByPath(sourcePath);
		if (!(file instanceof TFile)) {
			console.error('Workout Log: File not found:', sourcePath);
			return false;
		}

		if (!sectionInfo) {
			console.error('Workout Log: No section info available - cannot update file. Try navigating away and back.');
			return false;
		}

		let updateSucceeded = false;

		await this.withLock(sourcePath, async () => {
			await this.app.vault.process(file, (content) => {
				const lines = content.split('\n');

				// Validate that the target location still has a workout code block
				const startLine = lines[sectionInfo.lineStart];
				if (!startLine || !startLine.trim().startsWith('```workout')) {
					console.error('Workout Log: Stale sectionInfo - expected ```workout at line', sectionInfo.lineStart, '. Try navigating away and back.');
					return content; // Return unchanged
				}

				// If we have an expected title, validate it matches
				if (expectedTitle) {
					const blockContent = lines.slice(sectionInfo.lineStart + 1, sectionInfo.lineEnd).join('\n');
					const titleMatch = blockContent.match(/^title:\s*(.+)$/m);
					const actualTitle = titleMatch?.[1]?.trim();
					if (actualTitle && actualTitle !== expectedTitle) {
						console.error('Workout Log: Title mismatch - expected', expectedTitle, 'but found', actualTitle);
						return content; // Return unchanged
					}
				}

				// Find the code block boundaries
				const codeBlockStart = sectionInfo.lineStart;
				const codeBlockEnd = sectionInfo.lineEnd;

				// Replace content between the code fences (exclusive of the fences themselves)
				const beforeFence = lines.slice(0, codeBlockStart + 1);
				const afterFence = lines.slice(codeBlockEnd);

				const newLines = [
					...beforeFence,
					newContent,
					...afterFence
				];

				updateSucceeded = true;
				return newLines.join('\n');
			});
		});

		return updateSucceeded;
	}

	async insertLineAfter(
		sourcePath: string,
		sectionInfo: SectionInfo | null,
		relativeLineIndex: number,
		newLine: string
	): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(sourcePath);
		if (!(file instanceof TFile)) {
			console.error('File not found:', sourcePath);
			return;
		}

		if (!sectionInfo) {
			console.error('No section info available');
			return;
		}

		await this.app.vault.process(file, (content) => {
			const lines = content.split('\n');

			// Calculate absolute line number
			// sectionInfo.lineStart is the ```workout line
			// relativeLineIndex is relative to inside the code block
			const absoluteLineIndex = sectionInfo.lineStart + 1 + relativeLineIndex;

			// Insert the new line after the specified line
			lines.splice(absoluteLineIndex + 1, 0, newLine);

			return lines.join('\n');
		});
	}
}
