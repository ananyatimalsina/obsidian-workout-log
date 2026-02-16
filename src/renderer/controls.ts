import { WorkoutState, WorkoutCallbacks, ParsedWorkout } from '../types';

export function renderWorkoutControls(
	container: HTMLElement,
	state: WorkoutState,
	callbacks: WorkoutCallbacks,
	parsed: ParsedWorkout
): HTMLElement {
	const controlsEl = container.createDiv({ cls: 'workout-controls' });

	if (state === 'planned') {
		const startBtn = controlsEl.createEl('button', {
			cls: 'workout-btn workout-btn-primary workout-btn-large',
			attr: { type: 'button' }
		});
		startBtn.createSpan({ cls: 'workout-btn-icon', text: '▶' });
		startBtn.createSpan({ text: 'Start Workout' });

		// Use a flag to prevent double-triggers
		let isProcessing = false;
		const handleStart = async (e: MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			
			if (isProcessing) {
				return;
			}
			
			isProcessing = true;
			startBtn.addClass('workout-btn-processing');
			startBtn.setAttribute('disabled', 'true');
			
			try {
				await callbacks.onStartWorkout();
			} catch (error) {
				console.error('[Workout Log] Error starting workout:', error);
			} finally {
				// Button will be gone after re-render, but reset just in case
				isProcessing = false;
				startBtn.removeClass('workout-btn-processing');
				startBtn.removeAttribute('disabled');
			}
		};
		
		startBtn.addEventListener('click', handleStart, { capture: true });
	} else if (state === 'completed') {
		// Completed label
		const completedLabel = controlsEl.createSpan({ cls: 'workout-completed-label' });
		completedLabel.createSpan({ cls: 'workout-btn-icon', text: '✓' });
		completedLabel.createSpan({ text: 'Workout logged and reset' });
	}

	return controlsEl;
}
