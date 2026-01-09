import { Exercise, ExerciseState, TimerState, WorkoutCallbacks } from '../types';
import { formatDuration } from '../parser/exercise';

const STATE_ICONS: Record<ExerciseState, string> = {
	'pending': '○',
	'inProgress': '◐',
	'completed': '✓',
	'skipped': '—'
};

// Generate a consistent color hue from exercise name (djb2 hash with better distribution)
function nameToHue(name: string): number {
	let hash = 5381;
	for (let i = 0; i < name.length; i++) {
		hash = ((hash << 5) + hash) ^ name.charCodeAt(i);
	}
	// Use golden ratio to spread hues more evenly
	const golden = 0.618033988749895;
	const normalized = (Math.abs(hash) % 1000) / 1000;
	return Math.floor(((normalized * golden) % 1) * 360);
}

export interface ExerciseElements {
	container: HTMLElement;
	timerEl: HTMLElement | null;
	inputs: Map<string, HTMLInputElement>;
}

// Check if exercise has non-Duration params
function hasDisplayableParams(exercise: Exercise): boolean {
	return exercise.params.some(p => p.key.toLowerCase() !== 'duration');
}

export function renderExercise(
	container: HTMLElement,
	exercise: Exercise,
	index: number,
	isActive: boolean,
	timerState: TimerState | null,
	callbacks: WorkoutCallbacks,
	workoutState: 'planned' | 'started' | 'completed',
	restDuration?: number
): ExerciseElements {
	const isSimple = !hasDisplayableParams(exercise);
	const exerciseEl = container.createDiv({
		cls: `workout-exercise state-${exercise.state}${isActive ? ' active' : ''}${isSimple ? ' simple' : ''}`
	});

	// Set color based on exercise name
	const hue = nameToHue(exercise.name);
	exerciseEl.style.setProperty('--exercise-color', `hsl(${hue}, 65%, 55%)`);

	const inputs = new Map<string, HTMLInputElement>();

	// Single row: icon | name | params | timer
	const mainRow = exerciseEl.createDiv({ cls: 'workout-exercise-main' });

	// State icon
	const iconEl = mainRow.createSpan({ cls: 'workout-exercise-icon' });
	iconEl.textContent = STATE_ICONS[exercise.state];

	// Exercise name
	const nameEl = mainRow.createSpan({ cls: 'workout-exercise-name' });
	nameEl.textContent = exercise.name;

	// Params inline (between name and timer) - chip/pill style
	if (hasDisplayableParams(exercise)) {
		const paramsEl = mainRow.createSpan({ cls: 'workout-exercise-params' });

		for (const param of exercise.params) {
			// Skip Duration param (shown in timer)
			if (param.key.toLowerCase() === 'duration') continue;

			const paramEl = paramsEl.createSpan({ cls: 'workout-param' });

			// × prefix for params without units (plain numbers)
			if (!param.unit) {
				paramEl.createSpan({ cls: 'workout-param-prefix', text: '×' });
			}

			if (param.editable && workoutState !== 'completed') {
				const input = paramEl.createEl('input', {
					cls: 'workout-param-input',
					type: 'text',
					value: param.value
				});
				// Track changes immediately (updates in-memory state)
				input.addEventListener('input', () => {
					callbacks.onParamChange(index, param.key, input.value);
				});
				input.addEventListener('keydown', (e) => {
					if (e.key === 'Enter') {
						input.blur();
					}
				});
				inputs.set(param.key, input);
			} else {
				paramEl.createSpan({ cls: 'workout-param-value', text: param.value });
			}

			// Unit after value
			if (param.unit) {
				paramEl.createSpan({ cls: 'workout-param-unit', text: ` ${param.unit}` });
			}
		}
	}

	// Timer display (right side)
	const timerEl = mainRow.createSpan({ cls: 'workout-exercise-timer' });

	if (exercise.state === 'completed' && exercise.recordedDuration) {
		timerEl.textContent = exercise.recordedDuration;
		timerEl.createSpan({ cls: 'timer-indicator recorded', text: ' ✓' });
	} else if (isActive && timerState) {
		updateExerciseTimer(timerEl, timerState, exercise.targetDuration);
	} else if (exercise.targetDuration) {
		timerEl.textContent = formatDuration(exercise.targetDuration);
		timerEl.createSpan({ cls: 'timer-indicator count-down', text: ' ▼' });
	} else if (exercise.state === 'pending') {
		timerEl.textContent = '--';
	}

	// Controls row (only for active exercise during workout)
	if (isActive && workoutState === 'started') {
		renderExerciseControls(exerciseEl, index, callbacks, restDuration);
	}

	return { container: exerciseEl, timerEl, inputs };
}

function renderExerciseControls(
	exerciseEl: HTMLElement,
	index: number,
	callbacks: WorkoutCallbacks,
	restDuration?: number
): void {
	const controlsEl = exerciseEl.createDiv({ cls: 'workout-exercise-controls' });

	// Pause/Resume button
	const pauseBtn = controlsEl.createEl('button', { cls: 'workout-btn', text: 'Pause' });
	pauseBtn.addEventListener('click', () => {
		if (pauseBtn.textContent === 'Pause') {
			callbacks.onPauseExercise();
			pauseBtn.textContent = 'Resume';
		} else {
			callbacks.onResumeExercise();
			pauseBtn.textContent = 'Pause';
		}
	});

	// Skip button
	const skipBtn = controlsEl.createEl('button', { cls: 'workout-btn', text: 'Skip' });
	skipBtn.addEventListener('click', () => {
		callbacks.onExerciseSkip(index);
	});

	// Finish group container
	const finishGroup = controlsEl.createDiv({ cls: 'workout-btn-group' });

	// Add Set button
	const addSetBtn = finishGroup.createEl('button', { cls: 'workout-btn', text: '+ Set' });
	addSetBtn.addEventListener('click', () => {
		callbacks.onExerciseAddSet(index);
	});

	// Add Rest button (only if restDuration is defined)
	if (restDuration !== undefined) {
		const addRestBtn = finishGroup.createEl('button', { cls: 'workout-btn', text: '+ Rest' });
		addRestBtn.addEventListener('click', () => {
			callbacks.onExerciseAddRest(index);
		});
	}

	// Next button (finish current, move to next)
	const nextBtn = finishGroup.createEl('button', { cls: 'workout-btn', text: 'Next' });
	nextBtn.addEventListener('click', () => {
		callbacks.onExerciseFinish(index);
	});
}

export function updateExerciseTimer(
	timerEl: HTMLElement,
	timerState: TimerState,
	targetDuration?: number
): void {
	timerEl.empty();

	if (targetDuration !== undefined) {
		// Countdown mode
		const remaining = targetDuration - timerState.exerciseElapsed;
		if (remaining > 0) {
			timerEl.textContent = formatDuration(remaining);
			timerEl.createSpan({ cls: 'timer-indicator count-down', text: ' ▼' });
		} else {
			// Overtime
			timerEl.textContent = formatDuration(Math.abs(remaining));
			timerEl.addClass('overtime');
			timerEl.createSpan({ cls: 'timer-indicator overtime', text: ' ⚠' });
		}
	} else {
		// Count up mode
		timerEl.textContent = formatDuration(timerState.exerciseElapsed);
		timerEl.createSpan({ cls: 'timer-indicator count-up', text: ' ▲' });
	}
}
