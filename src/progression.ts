import { ExerciseParam } from './types';

export interface ProgressionResult {
	params: ExerciseParam[];
	shouldAddSet: boolean; // True when both reps and weight are at max
}

/**
 * Evaluates a progression formula with variable substitution
 * @param formula - The formula string (e.g., "w+2", "((w/r)^2)")
 * @param variables - Map of variable names to values (e.g., {w: 38, r: 8})
 * @returns The evaluated result as a number
 */
export function evaluateProgressionFormula(formula: string, variables: Record<string, number>): number {
	// Replace variables with their values
	let expression = formula;
	
	// Replace ^ with ** for JavaScript exponentiation
	expression = expression.replace(/\^/g, '**');
	
	// Replace variable names with their values
	for (const [varName, value] of Object.entries(variables)) {
		// Use word boundaries to avoid replacing partial matches
		const regex = new RegExp(`\\b${varName}\\b`, 'g');
		expression = expression.replace(regex, value.toString());
	}
	
	try {
		// Evaluate the expression safely
		// Note: Using Function constructor for math evaluation
		// This is safe since we control the input format
		const result = new Function(`return ${expression}`)();
		
		if (typeof result !== 'number' || !isFinite(result)) {
			throw new Error('Invalid result');
		}
		
		return result;
	} catch (error) {
		console.error('Failed to evaluate progression formula:', formula, error);
		throw new Error(`Invalid progression formula: ${formula}`);
	}
}

/**
 * Applies progression formulas to exercise parameters with overflow handling.
 * 
 * Progression Logic:
 * 1. First pass: Progress params with maxValue (e.g., Reps) - these always progress
 * 2. Second pass: Progress conditional params (e.g., Weight) - only when reps overflow
 * 3. Set addition: Triggered when reps reach max AND (weight reaches max OR no weight exists)
 * 
 * @param params - Array of exercise parameters
 * @returns ProgressionResult with new params and shouldAddSet flag
 */
export function applyProgression(params: ExerciseParam[]): ProgressionResult {
	// First, build a map of variables from param keys to values
	const variables: Record<string, number> = {};
	
	for (const param of params) {
		// Skip duration params
		if (param.key.toLowerCase() === 'duration') continue;
		
		// Use first letter of key as variable name (lowercase)
		const varName = param.key.charAt(0).toLowerCase();
		const value = parseFloat(param.value);
		
		if (!isNaN(value)) {
			variables[varName] = value;
		}
	}
	
	// Track which params overflowed (hit their max)
	const overflowedParams = new Set<string>();
	
	// Track if we're in the "both wrapped" condition (not just capped, but actually wrapped to initial)
	let repsWrapped = false;
	let weightWrapped = false;
	
	// First pass: Process params WITH maxValue
	// Distinguish between "always progress" params (like Reps) and "conditional progress" params (like Weight)
	const firstPassParams = params.map(param => {
		// Skip params without formula
		if (!param.progressionFormula) {
			return param;
		}
		
		// Only process params with maxValue in first pass
		if (!param.maxValue) {
			return param; // Will be processed in second pass if overflow occurs
		}
		
		const currentVal = parseFloat(param.value);
		const maxVal = parseFloat(param.maxValue);
		
		// Check if this is a "conditional progress" param (Weight with maxValue)
		// Weight params should only progress when reps overflow, not always
		const isConditionalParam = param.key.toLowerCase() === 'weight';
		
		// For conditional params (weight), just check if wrapped (not just at max), don't progress yet
		if (isConditionalParam) {
			// Weight wrapping is detected in second pass, not here
			return param; // Will be handled in second pass if overflow occurs
		}
		
		try {
			const newValue = evaluateProgressionFormula(param.progressionFormula, variables);
			
			// Round to 2 decimal places to avoid floating point issues
			const roundedValue = Math.round(newValue * 100) / 100;
			
			// Check if we've exceeded the max
			if (!isNaN(maxVal) && roundedValue > maxVal) {
				// Check if current value is already at max
				if (currentVal >= maxVal) {
					// Already at max, now wrap to initial
					overflowedParams.add(param.key);
					const resetValue = param.initialValue || param.value;
					
					// Track that reps wrapped (reset to initial)
					if (param.key.toLowerCase() === 'reps') {
						repsWrapped = true;
					}
					
					// Update variables map with the reset value for second pass
					const varName = param.key.charAt(0).toLowerCase();
					const resetNumValue = parseFloat(resetValue);
					if (!isNaN(resetNumValue)) {
						variables[varName] = resetNumValue;
					}
					
					return {
						...param,
						value: resetValue
					};
				} else {
					// Not at max yet, cap at max value first (but don't mark as wrapped)
					const varName = param.key.charAt(0).toLowerCase();
					variables[varName] = maxVal;
					
					return {
						...param,
						value: maxVal.toString()
					};
				}
			}
			
			// Update variables map with the new progressed value for second pass
			const varName = param.key.charAt(0).toLowerCase();
			variables[varName] = roundedValue;
			
			return {
				...param,
				value: roundedValue.toString()
			};
		} catch (error) {
			console.error('Failed to apply progression for param:', param.key, error);
			// Return unchanged if formula fails
			return param;
		}
	});
	
	// Second pass: Process params WITHOUT maxValue OR conditional params (Weight with maxValue)
	// These only progress if a param with maxValue overflowed
	let finalParams: ExerciseParam[];
	
	if (overflowedParams.size > 0) {
		finalParams = firstPassParams.map(param => {
			// Skip params that were already processed (Reps-like with maxValue)
			if (param.maxValue && param.key.toLowerCase() !== 'weight') {
				return param;
			}
			
			// Skip params without formula
			if (!param.progressionFormula) {
				return param;
			}
			
			try {
				// Apply progression using updated variables (which include overflowed values)
				const newValue = evaluateProgressionFormula(param.progressionFormula, variables);
				const PRECISION = 100;
				const roundedValue = Math.round(newValue * PRECISION) / PRECISION;
				
				// Check if weight exceeds max (needs capping or wrapping)
				if (param.key.toLowerCase() === 'weight' && param.maxValue) {
					const currentVal = parseFloat(param.value);
					const maxVal = parseFloat(param.maxValue);
					
					if (!isNaN(maxVal) && roundedValue > maxVal) {
						// Check if already at max
						if (currentVal >= maxVal) {
							// Already at max, wrap to initial (THIS is when weight wraps)
							weightWrapped = true;
							const resetValue = param.initialValue || param.value;
							return {
								...param,
								value: resetValue
							};
						} else {
							// Not at max yet, cap at max (but don't mark as wrapped)
							return {
								...param,
								value: maxVal.toString()
							};
						}
					}
				}
				
				return {
					...param,
					value: roundedValue.toString()
				};
			} catch (error) {
				console.error('Failed to apply progression for param:', param.key, error);
				return param;
			}
		});
	} else {
		// No overflow occurred, weight stays the same (no wrapping)
		finalParams = firstPassParams;
	}
	
	// Determine if we should add a new set:
	// BOTH reps and weight must have WRAPPED (not just capped at max)
	// Reps wrapped AND (weight wrapped OR no weight param exists)
	const hasWeightParam = params.some(p => p.key.toLowerCase() === 'weight');
	const shouldAddSet = repsWrapped && (weightWrapped || !hasWeightParam);
	
	return {
		params: finalParams,
		shouldAddSet
	};
}

/**
 * Parses a param value that may contain a progression formula and bounds
 * Format: (formula){initial,max}value or (formula)value or {initial,max}value or just value
 * Examples: "(r+1){8,12}8", "((w/r)^2)10", "{60,}60", "8"
 * @returns {value, progressionFormula, initialValue, maxValue}
 */
export function parseProgressionValue(valueStr: string): { 
	value: string; 
	progressionFormula?: string;
	initialValue?: string;
	maxValue?: string;
} {
	// Pattern: (formula){initial,max}value or (formula)value or {initial,max}value or value
	// First check if it starts with a formula (parentheses)
	if (valueStr.startsWith('(')) {
		// Find the matching closing parenthesis by counting
		let depth = 0;
		let formulaEnd = -1;
		
		for (let i = 0; i < valueStr.length; i++) {
			if (valueStr[i] === '(') {
				depth++;
			} else if (valueStr[i] === ')') {
				depth--;
				if (depth === 0) {
					formulaEnd = i;
					break;
				}
			}
		}
		
		if (formulaEnd > 0) {
			const formula = valueStr.substring(1, formulaEnd).trim();
			const remainder = valueStr.substring(formulaEnd + 1);
			
			// Check if remainder has bounds (using curly braces)
			const boundsMatch = remainder.match(/^\{([^,]*),([^\}]*)\}(.+)$/);
			if (boundsMatch) {
				const initial = boundsMatch[1]?.trim() || undefined;
				const max = boundsMatch[2]?.trim() || undefined;
				const value = boundsMatch[3]?.trim() || '';
				return { 
					value, 
					progressionFormula: formula,
					initialValue: initial,
					maxValue: max
				};
			}
			
			// No bounds, just formula and value
			return { value: remainder.trim(), progressionFormula: formula };
		}
	}
	
	// No formula, check for bounds only (using curly braces)
	const boundsOnlyMatch = valueStr.match(/^\{([^,]*),([^\}]*)\}(.+)$/);
	if (boundsOnlyMatch) {
		const initial = boundsOnlyMatch[1]?.trim() || undefined;
		const max = boundsOnlyMatch[2]?.trim() || undefined;
		const value = boundsOnlyMatch[3]?.trim() || '';
		return { 
			value,
			initialValue: initial,
			maxValue: max
		};
	}
	
	// Just a plain value
	return { value: valueStr };
}

/**
 * Formats a param value with its progression formula and bounds
 * @param value - The current value
 * @param formula - The progression formula (optional)
 * @param initialValue - The initial value for overflow resets (optional)
 * @param maxValue - The maximum value before overflow (optional)
 * @returns Formatted string like "(w+2){38,50}38" or "(w+2)38" or "{38,50}38" or just "38"
 */
export function formatProgressionValue(
	value: string, 
	formula?: string, 
	initialValue?: string, 
	maxValue?: string
): string {
	let result = value;
	
	// Add bounds if present (using curly braces)
	if (initialValue !== undefined || maxValue !== undefined) {
		const initial = initialValue || '';
		const max = maxValue || '';
		result = `{${initial},${max}}${result}`;
	}
	
	// Add formula if present
	if (formula) {
		result = `(${formula})${result}`;
	}
	
	return result;
}
