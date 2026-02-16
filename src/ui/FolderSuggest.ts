import { App, TFolder, TAbstractFile, Modal, FuzzySuggestModal, setIcon } from 'obsidian';

export class FolderSuggest {
	private modal: FolderSuggestModal | null = null;
	private button: HTMLElement;

	constructor(
		app: App,
		public inputEl: HTMLInputElement,
		private onSelect: (value: string) => void
	) {
		// Create a browse button next to the input
		this.button = inputEl.parentElement!.createEl('button', {
			cls: 'clickable-icon',
			attr: {
				'aria-label': 'Browse folders',
				'type': 'button'
			}
		});
		setIcon(this.button, 'folder');

		// Open modal on button click
		this.button.addEventListener('click', (e) => {
			e.preventDefault();
			this.openModal(app);
		});
	}

	private openModal(app: App) {
		if (this.modal) return; // Prevent multiple modals
		
		this.modal = new FolderSuggestModal(app, this.inputEl.value, (folder) => {
			this.inputEl.value = folder.path;
			this.onSelect(folder.path);
			this.inputEl.dispatchEvent(new Event('input'));
			this.modal = null;
		});
		
		// Clear modal reference when closed
		this.modal.onClose = () => {
			this.modal = null;
		};
		
		this.modal.open();
	}
}

class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
	private currentValue: string;
	private onChoose: (folder: TFolder) => void;

	constructor(app: App, currentValue: string, onChoose: (folder: TFolder) => void) {
		super(app);
		this.currentValue = currentValue;
		this.onChoose = onChoose;
		this.setPlaceholder('Type to search for folders...');
	}

	getItems(): TFolder[] {
		const folders: TFolder[] = [];
		const abstractFiles = this.app.vault.getAllLoadedFiles();
		
		abstractFiles.forEach((file: TAbstractFile) => {
			if (file instanceof TFolder) {
				folders.push(file);
			}
		});

		return folders;
	}

	getItemText(folder: TFolder): string {
		return folder.path;
	}

	onChooseItem(folder: TFolder): void {
		this.onChoose(folder);
	}
}
