import { Plugin, MarkdownPostProcessorContext } from 'obsidian';
import { parseWorkout } from './parser';
import { serializeWorkout, updateParamValue, updateExerciseState, addSet, setRecordedDuration, lockAllFields, createSampleWorkout } from './serializer';
import { renderWorkout } from './renderer';
import { TimerManager } from './timer/manager';
import { FileUpdater } from './file/updater';
import { ParsedWorkout, WorkoutCallbacks, SectionInfo, Exercise, WorkoutLogSettings } from './types';
import { formatDurationHuman } from './parser/exercise';
import { DEFAULT_SETTINGS, WorkoutLogSettingTab } from './settings';
import { WorkoutLogger } from './logger';

export default class WorkoutLogPlugin extends Plugin {
	private timerManager: TimerManager = new TimerManager();
	private fileUpdater: FileUpdater | null = null;
	logger: WorkoutLogger | null = null;
	settings: WorkoutLogSettings = DEFAULT_SETTINGS;

	async onload(): Promise<void> {
		// Load settings
		await this.loadSettings();

		// Initialize services
		this.fileUpdater = new FileUpdater(this.app);
		this.logger = new WorkoutLogger(this.app, this.settings);

		// Register settings tab
		this.addSettingTab(new WorkoutLogSettingTab(this.app, this));

		// Register the workout code block processor
		this.registerMarkdownCodeBlockProcessor('workout', (source, el, ctx) => {
			this.processWorkoutBlock(source, el, ctx);
		});
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		// Update logger settings if logger exists
		if (this.logger) {
			this.logger.updateSettings(this.settings);
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		// Update logger settings
		if (this.logger) {
			this.logger.updateSettings(this.settings);
		}
	}

	onunload(): void {
		this.timerManager.destroy();
	}

	private processWorkoutBlock(
		source: string,
		el: HTMLElement,
		ctx: MarkdownPostProcessorContext
	): void {
		const parsed = parseWorkout(source);
		const sectionInfo = ctx.getSectionInfo(el) as SectionInfo | null;

		// Warn if sectionInfo is null - this can cause issues with multiple workouts
		if (!sectionInfo) {
			console.warn('Workout Log: sectionInfo is null for', ctx.sourcePath, '- file updates may not work correctly');
		}

		const workoutId = `${ctx.sourcePath}:${sectionInfo?.lineStart ?? 0}`;

		// Sync timer state with parsed state (handles undo/external changes)
		const isTimerRunning = this.timerManager.isTimerRunning(workoutId);
		if (isTimerRunning && parsed.metadata.state !== 'started') {
			// File was reverted to non-started state, stop the timer
			this.timerManager.stopWorkoutTimer(workoutId);
		} else if (isTimerRunning && parsed.metadata.state === 'started') {
			// Sync active exercise index with parsed state (handles undo of exercise actions)
			const parsedActiveIndex = parsed.exercises.findIndex(e => e.state === 'inProgress');
			const timerActiveIndex = this.timerManager.getActiveExerciseIndex(workoutId);
			if (parsedActiveIndex >= 0 && parsedActiveIndex !== timerActiveIndex) {
				// Active exercise changed externally (undo), update timer
				this.timerManager.setActiveExerciseIndex(workoutId, parsedActiveIndex);
			}
		}

		const callbacks = this.createCallbacks(ctx, sectionInfo, parsed, workoutId);

		renderWorkout({
			el,
			parsed,
			callbacks,
			workoutId,
			timerManager: this.timerManager
		});
	}

	private createCallbacks(
		ctx: MarkdownPostProcessorContext,
		sectionInfo: SectionInfo | null,
		parsed: ParsedWorkout,
		workoutId: string
	): WorkoutCallbacks {
		// Keep a reference to current parsed state
		let currentParsed = parsed;
		let hasPendingChanges = false;

		const updateFile = async (newParsed: ParsedWorkout): Promise<void> => {
			currentParsed = newParsed;
			hasPendingChanges = false;
			const newContent = serializeWorkout(newParsed);
			// Pass title for validation to prevent cross-block contamination
			const expectedTitle = currentParsed.metadata.title;
			await this.fileUpdater?.updateCodeBlock(ctx.sourcePath, sectionInfo, newContent, expectedTitle);
		};

		// Flush any pending param changes to file
		const flushChanges = async (): Promise<void> => {
			if (hasPendingChanges) {
				await updateFile(currentParsed);
			}
		};

		return {
			onStartWorkout: async (): Promise<void> => {
				hasPendingChanges = false; // Will be saved by updateFile below
				// Update state to started
				currentParsed.metadata.state = 'started';
				currentParsed.metadata.startDate = this.formatStartDate(new Date());

				// Activate first pending exercise
				const firstPending = currentParsed.exercises.findIndex(e => e.state === 'pending');
				if (firstPending >= 0) {
					const exercise = currentParsed.exercises[firstPending];
					if (exercise) {
						exercise.state = 'inProgress';
					}
				}

				await updateFile(currentParsed);

				// Start timers
				this.timerManager.startWorkoutTimer(workoutId, firstPending >= 0 ? firstPending : 0);
			},

			onFinishWorkout: async (): Promise<void> => {
				// Calculate duration
				const timerState = this.timerManager.getTimerState(workoutId);
				if (timerState) {
					currentParsed.metadata.duration = formatDurationHuman(timerState.workoutElapsed);
				}

				currentParsed.metadata.state = 'completed';

				// Lock all fields
				currentParsed = lockAllFields(currentParsed);

				// Log the completed workout
				if (this.logger) {
					await this.logger.logWorkout(currentParsed);
				}

				// Reset workout to planned state
				currentParsed = this.resetWorkout(currentParsed);

				await updateFile(currentParsed);

				// Stop timer
				this.timerManager.stopWorkoutTimer(workoutId);
			},

		onExerciseFinish: async (exerciseIndex: number): Promise<void> => {
			hasPendingChanges = false; // Will be saved by updateFile below
			const exercise = currentParsed.exercises[exerciseIndex];
			if (!exercise) return;

			// Record duration
			const timerState = this.timerManager.getTimerState(workoutId);
			if (timerState) {
				currentParsed = setRecordedDuration(
					currentParsed,
					exerciseIndex,
					formatDurationHuman(timerState.exerciseElapsed)
				);
			}

			// Check if this exercise has a rest period
			const restDuration = exercise.restAfter ?? currentParsed.metadata.restDuration;
			const hasMoreExercises = currentParsed.exercises.some(
				(e, i) => i > exerciseIndex && e.state === 'pending'
			);

			if (restDuration && hasMoreExercises) {
				// Start rest timer (exercise stays inProgress during rest)
				this.timerManager.startRest(workoutId, restDuration);

				// Save the recorded duration but keep exercise in progress
				await updateFile(currentParsed);
			} else {
				// No rest needed, mark as completed immediately
				currentParsed = updateExerciseState(currentParsed, exerciseIndex, 'completed');

				// Find next pending exercise
				const nextPending = currentParsed.exercises.findIndex(
					(e, i) => i > exerciseIndex && e.state === 'pending'
				);

				if (nextPending >= 0) {
					// Activate next exercise
					currentParsed = updateExerciseState(currentParsed, nextPending, 'inProgress');

					// Advance timer BEFORE file update so re-render sees reset timer
					this.timerManager.advanceExercise(workoutId, nextPending);

					await updateFile(currentParsed);
				} else {
					// No more exercises, complete workout
					currentParsed.metadata.state = 'completed';
					const finalState = this.timerManager.getTimerState(workoutId);
					if (finalState) {
						currentParsed.metadata.duration = formatDurationHuman(finalState.workoutElapsed);
					}
					currentParsed = lockAllFields(currentParsed);
					
					// Log the completed workout
					if (this.logger) {
						await this.logger.logWorkout(currentParsed);
					}
					
					// Reset workout to planned state
					currentParsed = this.resetWorkout(currentParsed);
					
					await updateFile(currentParsed);
					this.timerManager.stopWorkoutTimer(workoutId);
				}
			}
		},

			onExerciseAddSet: async (exerciseIndex: number): Promise<void> => {
				hasPendingChanges = false; // Will be saved by updateFile below
				const exercise = currentParsed.exercises[exerciseIndex];
				if (!exercise) return;

				// Record duration for current set
				const timerState = this.timerManager.getTimerState(workoutId);
				if (timerState) {
					currentParsed = setRecordedDuration(
						currentParsed,
						exerciseIndex,
						formatDurationHuman(timerState.exerciseElapsed)
					);
				}

				// Mark current as completed
				currentParsed = updateExerciseState(currentParsed, exerciseIndex, 'completed');

				// Add new set (inserts after current)
				currentParsed = addSet(currentParsed, exerciseIndex);

				// The new set is at exerciseIndex + 1, activate it
				currentParsed = updateExerciseState(currentParsed, exerciseIndex + 1, 'inProgress');

				// Advance timer BEFORE file update so re-render sees reset timer
				this.timerManager.advanceExercise(workoutId, exerciseIndex + 1);

				await updateFile(currentParsed);
			},

			onExerciseAddRest: async (): Promise<void> => {
				// No-op: Rest is now handled automatically via restAfter property
			},

			onExerciseSkip: async (exerciseIndex: number): Promise<void> => {
				hasPendingChanges = false; // Will be saved by updateFile below
				// Record duration if any time elapsed
				const timerState = this.timerManager.getTimerState(workoutId);
				if (timerState && timerState.exerciseElapsed > 0) {
					currentParsed = setRecordedDuration(
						currentParsed,
						exerciseIndex,
						formatDurationHuman(timerState.exerciseElapsed)
					);
				}

				currentParsed = updateExerciseState(currentParsed, exerciseIndex, 'skipped');

				// Find next pending
				const nextPending = currentParsed.exercises.findIndex(
					(e, i) => i > exerciseIndex && e.state === 'pending'
				);

				if (nextPending >= 0) {
					currentParsed = updateExerciseState(currentParsed, nextPending, 'inProgress');

					// Advance timer BEFORE file update so re-render sees reset timer
					this.timerManager.advanceExercise(workoutId, nextPending);

					await updateFile(currentParsed);
				} else {
					// No more exercises, complete workout
					currentParsed.metadata.state = 'completed';
					const finalState = this.timerManager.getTimerState(workoutId);
					if (finalState) {
						currentParsed.metadata.duration = formatDurationHuman(finalState.workoutElapsed);
					}
					currentParsed = lockAllFields(currentParsed);

					// Log the completed workout
					if (this.logger) {
						await this.logger.logWorkout(currentParsed);
					}
					
					// Reset workout to planned state
					currentParsed = this.resetWorkout(currentParsed);

					// Stop timer BEFORE file update
					this.timerManager.stopWorkoutTimer(workoutId);

					await updateFile(currentParsed);
				}
			},

			onParamChange: (exerciseIndex: number, paramKey: string, newValue: string): void => {
				// Check if value actually changed
				const exercise = currentParsed.exercises[exerciseIndex];
				const param = exercise?.params.find(p => p.key === paramKey);
				if (param?.value === newValue) {
					return; // No change, skip update
				}
				currentParsed = updateParamValue(currentParsed, exerciseIndex, paramKey, newValue);
				hasPendingChanges = true;
				// Don't save to file yet - wait for flush
			},

			onFlushChanges: flushChanges,

			onPauseExercise: (): void => {
				this.timerManager.pauseExercise(workoutId);
			},

			onResumeExercise: (): void => {
				this.timerManager.resumeExercise(workoutId);
			},

			onRestComplete: async (exerciseIndex: number): Promise<void> => {
				hasPendingChanges = false; // Will be saved by updateFile below

				// End rest state
				this.timerManager.endRest(workoutId);

				// Mark current exercise as completed
				currentParsed = updateExerciseState(currentParsed, exerciseIndex, 'completed');

				// Find next pending exercise
				const nextPending = currentParsed.exercises.findIndex(
					(e, i) => i > exerciseIndex && e.state === 'pending'
				);

				if (nextPending >= 0) {
					// Activate next exercise
					currentParsed = updateExerciseState(currentParsed, nextPending, 'inProgress');

					// Advance timer BEFORE file update so re-render sees reset timer
					this.timerManager.advanceExercise(workoutId, nextPending);

					await updateFile(currentParsed);
				} else {
					// No more exercises, complete workout
					currentParsed.metadata.state = 'completed';
					const finalState = this.timerManager.getTimerState(workoutId);
					if (finalState) {
						currentParsed.metadata.duration = formatDurationHuman(finalState.workoutElapsed);
					}
					currentParsed = lockAllFields(currentParsed);
					
					// Log the completed workout
					if (this.logger) {
						await this.logger.logWorkout(currentParsed);
					}
					
					// Reset workout to planned state
					currentParsed = this.resetWorkout(currentParsed);
					
					await updateFile(currentParsed);
					this.timerManager.stopWorkoutTimer(workoutId);
				}
			},

			onRestSkip: async (exerciseIndex: number): Promise<void> => {
				hasPendingChanges = false; // Will be saved by updateFile below

				// End rest state
				this.timerManager.endRest(workoutId);

				// Mark current exercise as completed
				currentParsed = updateExerciseState(currentParsed, exerciseIndex, 'completed');

				// Find next pending exercise
				const nextPending = currentParsed.exercises.findIndex(
					(e, i) => i > exerciseIndex && e.state === 'pending'
				);

				if (nextPending >= 0) {
					// Activate next exercise
					currentParsed = updateExerciseState(currentParsed, nextPending, 'inProgress');

					// Advance timer BEFORE file update so re-render sees reset timer
					this.timerManager.advanceExercise(workoutId, nextPending);

					await updateFile(currentParsed);
				} else {
					// No more exercises, complete workout
					currentParsed.metadata.state = 'completed';
					const finalState = this.timerManager.getTimerState(workoutId);
					if (finalState) {
						currentParsed.metadata.duration = formatDurationHuman(finalState.workoutElapsed);
					}
					currentParsed = lockAllFields(currentParsed);
					
					// Log the completed workout
					if (this.logger) {
						await this.logger.logWorkout(currentParsed);
					}
					
					// Reset workout to planned state
					currentParsed = this.resetWorkout(currentParsed);
					
					await updateFile(currentParsed);
					this.timerManager.stopWorkoutTimer(workoutId);
				}
			},

			onAddSample: async (): Promise<void> => {
				const sampleWorkout = createSampleWorkout();
				const newContent = serializeWorkout(sampleWorkout);
				await this.fileUpdater?.updateCodeBlock(
					ctx.sourcePath,
					sectionInfo,
					newContent,
					sampleWorkout.metadata.title
				);
			}
		};
	}

	private resetWorkout(workout: ParsedWorkout): ParsedWorkout {
		// Reset metadata
		workout.metadata.state = 'planned';
		workout.metadata.startDate = undefined;
		workout.metadata.duration = undefined;

		// Reset all exercises to pending state and unlock fields
		workout.exercises = workout.exercises.map(exercise => ({
			...exercise,
			state: 'pending',
			recordedDuration: undefined,
			params: exercise.params.map(param => ({
				...param,
				locked: false
			}))
		}));

		return workout;
	}

	private formatStartDate(date: Date): string {
		const year = date.getFullYear();
		const month = String(date.getMonth() + 1).padStart(2, '0');
		const day = String(date.getDate()).padStart(2, '0');
		const hours = String(date.getHours()).padStart(2, '0');
		const minutes = String(date.getMinutes()).padStart(2, '0');
		return `${year}-${month}-${day} ${hours}:${minutes}`;
	}
}
