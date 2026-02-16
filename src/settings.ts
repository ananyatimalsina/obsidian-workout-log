import { App, PluginSettingTab, Setting } from 'obsidian';
import WorkoutLogPlugin from './main';
import { WorkoutLogSettings } from './types';
import { FolderSuggest } from './ui/FolderSuggest';

export const DEFAULT_SETTINGS: WorkoutLogSettings = {
	logFolder: 'Workout Logs',
	logGrouping: 'daily'
};

export class WorkoutLogSettingTab extends PluginSettingTab {
	plugin: WorkoutLogPlugin;

	constructor(app: App, plugin: WorkoutLogPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		containerEl.createEl('h2', { text: 'Workout Log Settings' });

		new Setting(containerEl)
			.setName('Log folder')
			.setDesc('Folder where completed workout logs will be saved')
			.addText(text => {
				text.setPlaceholder('Workout Logs');
				
				// Only set value if it's different from default (so placeholder shows)
				if (this.plugin.settings.logFolder !== 'Workout Logs') {
					text.setValue(this.plugin.settings.logFolder);
				}
				
				// Keep reference to prevent garbage collection
				const folderSuggest = new FolderSuggest(
					this.app, 
					text.inputEl,
					async (value) => {
						this.plugin.settings.logFolder = value || 'Workout Logs';
						await this.plugin.saveSettings();
						this.plugin.logger?.updateSettings(this.plugin.settings);
					}
				);
				
				// Also handle manual text input
				text.onChange(async (value) => {
					this.plugin.settings.logFolder = value || 'Workout Logs';
					await this.plugin.saveSettings();
					this.plugin.logger?.updateSettings(this.plugin.settings);
				});
			});

		new Setting(containerEl)
			.setName('Log grouping')
			.setDesc('How to group workout logs in files')
			.addDropdown(dropdown => dropdown
				.addOption('daily', 'Daily - One file per day')
				.addOption('weekly', 'Weekly - One file per week')
				.setValue(this.plugin.settings.logGrouping)
				.onChange(async (value) => {
					this.plugin.settings.logGrouping = value as 'daily' | 'weekly';
					await this.plugin.saveSettings();
					// Update logger settings
					this.plugin.logger?.updateSettings(this.plugin.settings);
				}));
	}
}
