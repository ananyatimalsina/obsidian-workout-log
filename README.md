# Workout Log

An Obsidian plugin for tracking fitness workouts using simple markdown.

## Overview

Track your workouts directly in Obsidian with interactive timers, editable values, and automatic progress tracking. All data is stored as plain markdown - easy to analyze, backup, and own forever.

![Workout Log in action](readme-files/workout-log.gif)

## Features

- **Timers**: Count-up for exercises, countdown for rest periods with auto-advance
- **Editable values**: Click to edit weight, reps, or duration during workout
- **Automatic Progression**: Define formulas to automatically increase weight/reps after each workout
- **Smart Set Addition**: Automatically adds sets when you max out reps and weight
- **Workout Logging**: Completed workouts are auto-saved to a configured folder with progression applied
- **Add Set**: Quickly add extra sets on the fly
- **Skip / Pause / Resume**: Full control over your workout flow
- **Undo support**: Ctrl+Z works - syncs timer state with file changes

## Installation

### Using BRAT (Recommended)
The easiest way to install and keep the plugin updated, especially useful for mobile:

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin from Obsidian's Community Plugins
2. Open BRAT settings (Settings → BRAT)
3. Click "Add Beta plugin"
4. Enter: `https://github.com/ldomaradzki/obsidian-workout-log`
5. Enable the plugin in Settings → Community Plugins

BRAT will automatically check for updates and notify you when new versions are available. Perfect for mobile users who can't manually copy files!

### Manual
1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release
2. Create folder: `<vault>/.obsidian/plugins/workout-log/`
3. Copy the files into the folder
4. Enable the plugin in Obsidian settings

### From Community Plugins
Coming soon.

## Usage

Create a code block with the `workout` language:

````markdown
```workout
title: Morning Workout
state: planned
startDate:
duration:
restDuration: 45s
---
- [ ] Squats | Weight: [60] kg | Reps: [10] | Rest: [45s]
- [ ] Bench Press | Weight: [40] kg | Reps: [8] | Rest: [60s]
- [ ] Plank | Duration: [60s]
```
````


### Metadata

| Field | Description |
|-------|-------------|
| `title` | Workout name (displayed in header) |
| `state` | `planned`, `started`, or `completed` |
| `startDate` | Auto-filled when workout starts |
| `duration` | Auto-filled when workout completes |
| `restDuration` | Default rest duration (fallback if exercise doesn't specify Rest) |

### Exercise Format

```
- [ ] Exercise Name | Key: [value] unit | Key: value | Rest: [60s]
```

- `[ ]` pending, `[\]` in progress, `[x]` completed, `[-]` skipped
- `[value]` = editable, `value` = locked
- `Duration: [60s]` = countdown timer
- `Rest: [60s]` = rest period after exercise (optional, falls back to `restDuration`)

### Automatic Progression

Define progression formulas to automatically increase parameters after completing a workout. When you finish a workout, it's logged to your configured folder and the workout block resets with progressed values.

#### Syntax

```
Key: [(formula){initial,max}value] unit
```

- **Formula** (optional): Math expression in parentheses, e.g., `(r+1)`, `(w+2.5)`, `((w/r)^2)`
  - Use first letter of param key as variable: `r` for Reps, `w` for Weight
  - Supports: `+`, `-`, `*`, `/`, `^` (exponentiation), parentheses
  - Can reference other params: `(w+r)`, `((w/r)^2)`

- **Bounds** (optional): Initial and max values in curly braces `{initial,max}`
  - `{8,12}`: Start at 8, max out at 12
  - `{60,80}`: Start at 60kg, max at 80kg
  - `{,80}`: No initial (stays at max when set is added)
  - When max is reached, value resets to initial (wrap-around)

- **Value**: Current value

#### Examples

```workout
title: Push Day
state: planned
---
- [ ] Bench Press | Weight: [(w+2.5){60,80}60] kg | Reps: [(r+1){8,12}8]
- [ ] Push-ups | Reps: [(r+2){10,20}10]
- [ ] Overhead Press | Weight: [{40,60}40] kg | Reps: [{8,12}8]
```

#### Progression Logic

1. **Reps (params with max)**: Always progress after each workout
   - `Reps: [(r+1){8,12}11]` → After workout: `12` → Next workout: `8` (reset to initial)

2. **Weight**: Only progresses when reps overflow (reset to initial)
   - When reps go from max (12) back to initial (8), weight increases
   - `Weight: [(w+2.5){60,80}70]` with reps overflowing → `72.5`

3. **Set Addition**: Automatically adds ONE new set when BOTH conditions met:
   - Reps reach their max value, AND
   - Weight reaches its max value (or no weight param exists)
   
   Example: `Reps: 12`, `Weight: 80` → Adds new set, resets all sets to `Reps: 8`, `Weight: 60` (or stays at 80 if `{,80}`)

#### Weight Wrap-Around Behavior

- **With initial** `{60,80}`: Wraps to initial (60) when set is added
  - Enables infinite progression: Reps → Weight → Volume (sets) → Repeat
  
- **Without initial** `{,80}`: Stays at max (80) when set is added
  - Useful when you want to maintain a specific weight

#### Bodyweight Exercises

For exercises without weight, sets are added when reps reach max:

```workout
- [ ] Push-ups | Reps: [(r+2){10,20}18]
```

When reps hit 20, a new set is added and all sets reset to 10 reps.

## Workout Logging

Completed workouts are automatically saved to a configured folder with progression applied to the source workout block.

### Settings

- **Log Folder**: Where completed workouts are saved (default: `workout-logs`)
- **Log Grouping**: 
  - **Daily**: One file per day (`YYYY-MM-DD.md`)
  - **Weekly**: One file per week (`YYYY-Www.md`)

### Workflow

1. Configure log folder in plugin settings
2. Complete a workout with progression formulas
3. On completion:
   - Workout is logged to the configured folder
   - Source workout block resets to `planned` state
   - Progression formulas are applied (reps/weight increase, sets may be added)
4. Start your next workout with progressed values!

## Examples

### Basic Workout (No Progression)

```workout
title: Quick Session
state: planned
startDate:
duration:
restDuration: 60s
---
- [ ] Squats | Weight: [60] kg | Reps: [10]
- [ ] Push-ups | Reps: [15]
```

### Strength Training with Progression

### Strength Training with Progression

```workout
title: Push Day
state: planned
startDate:
duration:
restDuration: 90s
---
- [ ] Bench Press | Weight: [(w+2.5){60,80}60] kg | Reps: [(r+1){8,12}8]
- [ ] Bench Press | Weight: [(w+2.5){60,80}60] kg | Reps: [(r+1){8,12}8]
- [ ] Bench Press | Weight: [(w+2.5){60,80}60] kg | Reps: [(r+1){8,12}8]
- [ ] Overhead Press | Weight: [(w+2.5){30,50}30] kg | Reps: [(r+1){8,12}8]
- [ ] Overhead Press | Weight: [(w+2.5){30,50}30] kg | Reps: [(r+1){8,12}8]
- [ ] Tricep Dips | Reps: [(r+1){8,15}8]
```

After completing this workout:
- Each exercise progresses: Reps increase by 1
- When reps hit 12 and wrap to 8, weight increases by 2.5kg
- When both reps AND weight max out (12 reps at 80kg), a new set is auto-added
- All sets reset: Reps back to 8, Weight back to 60

### Bodyweight Training

```workout
title: Calisthenics
state: planned
startDate:
duration:
---
- [ ] Push-ups | Reps: [(r+2){10,20}10]
- [ ] Push-ups | Reps: [(r+2){10,20}10]
- [ ] Pull-ups | Reps: [(r+1){5,12}5]
- [ ] Squats | Reps: [(r+5){20,50}20]
```

When reps max out (e.g., 20 push-ups), a new set is automatically added.

### HIIT / Timed Workout

```workout
title: Quick HIIT
state: planned
startDate:
duration:
restDuration: 10s
---
- [ ] Jumping Jacks | Duration: [30s] | Rest: [10s]
- [ ] Burpees | Duration: [30s] | Rest: [10s]
- [ ] Mountain Climbers | Duration: [30s]
```

## Screenshots

### Planned
![Planned workout](readme-files/workout-log-planned.png)

### In Progress
![Workout in progress with markdown source view](readme-files/workout-log-ongoing-markdown.png)

### Completed
![Completed workout](readme-files/workout-log-completed.png)

## Building from Source

```bash
npm install
npm run build    # Production build
npm run dev      # Watch mode
```

## License

MIT
