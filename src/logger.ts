import { App, TFile, moment } from 'obsidian';
import { ParsedWorkout, LogGrouping, WorkoutLogSettings } from './types';
import { serializeWorkout } from './serializer';

export class WorkoutLogger {
	private settings: WorkoutLogSettings;

	constructor(private app: App, settings: WorkoutLogSettings) {
		this.settings = settings;
	}

	/**
	 * Update logger settings (called when settings change)
	 */
	updateSettings(settings: WorkoutLogSettings): void {
		this.settings = settings;
	}

	/**
	 * Get the log file path for the current date based on grouping strategy
	 */
	getLogFilePath(): string {
		const now = moment();
		const { logFolder, logGrouping } = this.settings;
		
		if (logGrouping === 'daily') {
			// Format: YYYY-MM-DD.md
			const dateStr = now.format('YYYY-MM-DD');
			return `${logFolder}/${dateStr}.md`;
		} else {
			// Weekly format: YYYY-Www.md (e.g., 2026-W07.md)
			const year = now.year();
			const week = now.week();
			return `${logFolder}/${year}-W${String(week).padStart(2, '0')}.md`;
		}
	}

	/**
	 * Get a human-readable title for the log section
	 */
	getLogSectionTitle(): string {
		const now = moment();
		const { logGrouping } = this.settings;
		
		if (logGrouping === 'daily') {
			// Format: "Monday, February 17, 2026"
			return now.format('dddd, MMMM D, YYYY');
		} else {
			// Format: "Week 7, 2026 (Feb 16 - Feb 22)"
			const weekStart = now.clone().startOf('week');
			const weekEnd = now.clone().endOf('week');
			const weekNum = now.week();
			return `Week ${weekNum}, ${now.year()} (${weekStart.format('MMM D')} - ${weekEnd.format('MMM D')})`;
		}
	}

	/**
	 * Log a completed workout to the appropriate log file
	 */
	async logWorkout(workout: ParsedWorkout): Promise<void> {
		const { logFolder, logGrouping } = this.settings;
		
		// Ensure log folder exists
		await this.ensureFolder(logFolder);

		const filePath = this.getLogFilePath();
		const workoutMarkdown = this.formatWorkoutLog(workout);

		// Get or create the log file
		let file = this.app.vault.getAbstractFileByPath(filePath);

		if (file instanceof TFile) {
			// File exists, append to it
			await this.appendToLogFile(file, workoutMarkdown);
		} else {
			// Create new file with header
			const header = `# ${this.getLogSectionTitle()}\n\n`;
			
			// For weekly logs, add initial date separator
			let initialContent = header;
			if (logGrouping === 'weekly') {
				const dayTitle = moment().format('dddd, MMMM D');
				initialContent += `### ${dayTitle}\n\n`;
			}
			
			await this.app.vault.create(filePath, initialContent + workoutMarkdown);
		}
	}

	/**
	 * Ensure the log folder exists, create if not
	 */
	private async ensureFolder(folderPath: string): Promise<void> {
		const folder = this.app.vault.getAbstractFileByPath(folderPath);
		if (!folder) {
			await this.app.vault.createFolder(folderPath);
		}
	}

	/**
	 * Format a workout as markdown for logging
	 */
	private formatWorkoutLog(workout: ParsedWorkout): string {
		const timestamp = moment().format('HH:mm');
		const serialized = serializeWorkout(workout);
		
		return `## ${workout.metadata.title || 'Workout'} - ${timestamp}\n\n\`\`\`workout\n${serialized}\n\`\`\`\n\n\n`;
	}

	/**
	 * Append workout to existing log file
	 */
	private async appendToLogFile(
		file: TFile,
		workoutMarkdown: string
	): Promise<void> {
		const content = await this.app.vault.read(file);
		const { logGrouping } = this.settings;
		
		// Check if we need to update the header for a new day within the same week
		let newContent = content;
		
		if (logGrouping === 'weekly') {
			// For weekly logs, add a date separator if this is a new day
			const today = moment().format('YYYY-MM-DD');
			const lastLoggedDate = this.extractLastLoggedDate(content);
			
			if (lastLoggedDate && lastLoggedDate !== today) {
				// New day, add separator
				const dayTitle = moment().format('dddd, MMMM D');
				newContent = content + `\n---\n\n### ${dayTitle}\n\n`;
			}
		}
		
		// Append the workout
		await this.app.vault.modify(file, newContent + workoutMarkdown);
	}

	/**
	 * Extract the last logged date from weekly log content
	 */
	private extractLastLoggedDate(content: string): string | null {
		// Look for the last workout block's startDate
		const matches = content.match(/startDate:\s*(\d{4}-\d{2}-\d{2})/g);
		if (matches && matches.length > 0) {
			const lastMatch = matches[matches.length - 1];
			if (lastMatch) {
				const dateMatch = lastMatch.match(/\d{4}-\d{2}-\d{2}/);
				return dateMatch ? dateMatch[0] : null;
			}
		}
		return null;
	}
}
