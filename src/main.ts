import { Plugin, MarkdownPostProcessorContext } from 'obsidian';
import { parseWorkout } from './parser';
import { serializeWorkout, updateParamValue, updateExerciseState, addSet, setRecordedDuration, lockAllFields, createSampleWorkout } from './serializer';
import { renderWorkout } from './renderer';
import { TimerManager } from './timer/manager';
import { FileUpdater } from './file/updater';
import { ParsedWorkout, WorkoutCallbacks, SectionInfo, Exercise, WorkoutLogSettings, ExerciseParam } from './types';
import { formatDurationHuman } from './parser/exercise';
import { DEFAULT_SETTINGS, WorkoutLogSettingTab } from './settings';
import { WorkoutLogger } from './logger';
import { applyProgression } from './progression';

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

	private 	processWorkoutBlock(
		source: string,
		el: HTMLElement,
		ctx: MarkdownPostProcessorContext
	): void {
		const parsed = parseWorkout(source);
		const sectionInfo = ctx.getSectionInfo(el) as SectionInfo | null;

		// Use a stable workout ID based on source content hash instead of line numbers
		// Line numbers change when metadata is added (startDate, duration, etc.)
		// We'll use the original source position + a hash of the initial exercises
		const sourceHash = this.getWorkoutHash(parsed);
		const workoutId = `${ctx.sourcePath}:${sourceHash}`;

		// Warn if sectionInfo is null on initial load
		if (!sectionInfo) {
			console.warn('[Workout Log] sectionInfo is null for', ctx.sourcePath, '- file updates will not work until you switch to edit mode and back');
		}

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

		const callbacks = this.createCallbacks(ctx, sectionInfo, parsed, workoutId, el);

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
		workoutId: string,
		el: HTMLElement
	): WorkoutCallbacks {
		// Keep a reference to current parsed state
		let currentParsed = parsed;
		
		// Function to get fresh sectionInfo before each file update
		const getSectionInfo = (): SectionInfo | null => {
			return ctx.getSectionInfo(el) as SectionInfo | null;
		};
		let hasPendingChanges = false;

		const updateFile = async (newParsed: ParsedWorkout): Promise<void> => {
			currentParsed = newParsed;
			hasPendingChanges = false;
			
			// Get fresh sectionInfo before each update to avoid stale line numbers
			const freshSectionInfo = getSectionInfo();
			
			// Check if sectionInfo is available
			if (!freshSectionInfo) {
				console.error('[Workout Log] Cannot update file - sectionInfo is null. Please switch to edit mode and back to reading mode to fix this.');
				return;
			}
			
			const newContent = serializeWorkout(newParsed);
			// Pass title for validation to prevent cross-block contamination
			const expectedTitle = currentParsed.metadata.title;
			const success = await this.fileUpdater?.updateCodeBlock(ctx.sourcePath, freshSectionInfo, newContent, expectedTitle);
			
			if (!success) {
				console.error('[Workout Log] File update failed');
			}
		};

		// Flush any pending param changes to file
		const flushChanges = async (): Promise<void> => {
			if (hasPendingChanges) {
				await updateFile(currentParsed);
			}
		};

		return {
			onStartWorkout: async (): Promise<void> => {
				// Check if we have valid section info
				if (!sectionInfo) {
					console.error('[Workout Log] Cannot start workout - sectionInfo is null. This usually happens on initial load. Try switching to edit mode and back.');
					return;
				}
				
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

				// Start timer BEFORE updateFile to avoid race condition
				// This ensures timer is running when Obsidian re-renders after file update
				this.timerManager.startWorkoutTimer(workoutId, firstPending >= 0 ? firstPending : 0);

				await updateFile(currentParsed);
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
				
				// Get fresh sectionInfo before update
				const freshSectionInfo = getSectionInfo();
				if (!freshSectionInfo) {
					console.error('[Workout Log] Cannot add sample - sectionInfo is null');
					return;
				}
				
				await this.fileUpdater?.updateCodeBlock(
					ctx.sourcePath,
					freshSectionInfo,
					newContent,
					sampleWorkout.metadata.title
				);
			},
			
			getSectionInfo
		};
	}

	/**
	 * Reset workout to planned state after completion, applying progression and adding sets as needed
	 */
	private resetWorkout(workout: ParsedWorkout): ParsedWorkout {
		// Reset metadata
		workout.metadata.state = 'planned';
		workout.metadata.startDate = undefined;
		workout.metadata.duration = undefined;

		// Track which exercise names have any skipped sets
		const skippedExercises = new Set<string>();
		for (const exercise of workout.exercises) {
			if (exercise.state === 'skipped') {
				skippedExercises.add(exercise.name);
			}
		}

		// Track which exercise names need new sets added (stores last occurrence index)
		const setAdditionNeeded = new Map<string, number>();

		// Apply progression to all exercises and track which need new sets
		workout.exercises = workout.exercises.map((exercise, index) => {
			const filteredParams = this.removeRecordedDurations(exercise);
			
			// Skip progression if any set of this exercise was skipped
			const shouldApplyProgression = !skippedExercises.has(exercise.name);
			const progressionResult = shouldApplyProgression 
				? applyProgression(filteredParams)
				: { params: filteredParams, shouldAddSet: false };
			
			const resetExercise = {
				...exercise,
				state: 'pending' as const,
				recordedDuration: undefined,
				params: progressionResult.params.map(param => ({
					...param,
					locked: false,
					editable: param.editable || (param.key.toLowerCase() === 'duration' && exercise.targetDuration !== undefined)
				}))
			};

			// Track last index for exercises needing set addition
			if (progressionResult.shouldAddSet) {
				setAdditionNeeded.set(exercise.name, index);
			}
			
			return resetExercise;
		});

		// Add new sets and reset params for exercises that hit max
		if (setAdditionNeeded.size > 0) {
			workout = this.addNewSetsAndReset(workout, setAdditionNeeded);
		}

		return workout;
	}

	/**
	 * Remove recorded duration params that shouldn't persist
	 */
	private removeRecordedDurations(exercise: Exercise): ExerciseParam[] {
		return exercise.params.filter(param => {
			if (param.key.toLowerCase() === 'duration' && !param.editable && !exercise.targetDuration) {
				return false;
			}
			return true;
		});
	}

	/**
	 * Add one new set per exercise and reset reps/weight on all existing sets
	 */
	private addNewSetsAndReset(workout: ParsedWorkout, setAdditionMap: Map<string, number>): ParsedWorkout {
		// Add new sets (process in reverse order to avoid index shifting issues)
		const sortedEntries = Array.from(setAdditionMap.entries())
			.sort((a, b) => b[1] - a[1]);
		
		for (const [exerciseName, lastIndex] of sortedEntries) {
			const exercise = workout.exercises[lastIndex];
			if (!exercise) continue;

			const newExercise: Exercise = {
				...structuredClone(exercise),
				state: 'pending',
				recordedDuration: undefined,
				lineIndex: exercise.lineIndex + 1
			};

			workout.exercises.splice(lastIndex + 1, 0, newExercise);

			// Update line indices for subsequent exercises
			for (let i = lastIndex + 2; i < workout.exercises.length; i++) {
				const ex = workout.exercises[i];
				if (ex) ex.lineIndex++;
			}
		}

		// Reset reps and weight on ALL sets of exercises that triggered set addition
		const exerciseNames = new Set(setAdditionMap.keys());
		workout.exercises = workout.exercises.map(exercise => {
			if (exerciseNames.has(exercise.name)) {
				return {
					...exercise,
					params: exercise.params.map(param => this.resetParamForNewSet(param))
				};
			}
			return exercise;
		});

		return workout;
	}

	/**
	 * Reset a parameter value when a new set is added
	 */
	private resetParamForNewSet(param: ExerciseParam): ExerciseParam {
		const key = param.key.toLowerCase();
		
		// Reset reps to initial
		if (key === 'reps' && param.initialValue !== undefined && param.maxValue !== undefined) {
			return { ...param, value: param.initialValue };
		}
		
		// Reset weight: wrap to initial if defined, otherwise cap at max
		if (key === 'weight') {
			if (param.initialValue !== undefined && param.initialValue !== '') {
				return { ...param, value: param.initialValue };
			}
			if (param.maxValue !== undefined) {
				const currentVal = parseFloat(param.value);
				const maxVal = parseFloat(param.maxValue);
				if (!isNaN(currentVal) && !isNaN(maxVal) && currentVal > maxVal) {
					return { ...param, value: maxVal.toString() };
				}
			}
		}
		
		return param;
	}

	private formatStartDate(date: Date): string {
		const year = date.getFullYear();
		const month = String(date.getMonth() + 1).padStart(2, '0');
		const day = String(date.getDate()).padStart(2, '0');
		const hours = String(date.getHours()).padStart(2, '0');
		const minutes = String(date.getMinutes()).padStart(2, '0');
		return `${year}-${month}-${day} ${hours}:${minutes}`;
	}

	/**
	 * Generate a stable hash for a workout based on its title and exercise structure
	 * This ensures the workout ID doesn't change when metadata is added
	 */
	private getWorkoutHash(parsed: ParsedWorkout): string {
		// Use title + exercise names as a stable identifier
		const identifier = parsed.metadata.title + ':' + 
			parsed.exercises.map(e => e.name).join(',');
		
		// Simple hash function
		let hash = 0;
		for (let i = 0; i < identifier.length; i++) {
			const char = identifier.charCodeAt(i);
			hash = ((hash << 5) - hash) + char;
			hash = hash & hash; // Convert to 32bit integer
		}
		return Math.abs(hash).toString(36);
	}
}
