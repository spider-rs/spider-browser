package spiderbrowser

import (
	"fmt"
	"os"
	"time"
)

// LogLevel controls logging verbosity.
type LogLevel int

const (
	LogDebug LogLevel = iota
	LogInfo
	LogWarn
	LogError
	LogSilent
)

// Logger provides structured logging for spider-browser.
type Logger struct {
	level LogLevel
}

var defaultLogger = &Logger{level: LogInfo}

// SetLogLevel sets the global log level.
func SetLogLevel(level LogLevel) {
	defaultLogger.level = level
}

func (l *Logger) debug(msg string, data ...any) {
	if l.level <= LogDebug {
		l.log("DEBUG", msg, data...)
	}
}

func (l *Logger) info(msg string, data ...any) {
	if l.level <= LogInfo {
		l.log("INFO", msg, data...)
	}
}

func (l *Logger) warn(msg string, data ...any) {
	if l.level <= LogWarn {
		l.log("WARN", msg, data...)
	}
}

func (l *Logger) logError(msg string, data ...any) {
	if l.level <= LogError {
		l.log("ERROR", msg, data...)
	}
}

func (l *Logger) log(level, msg string, data ...any) {
	ts := time.Now().UTC().Format(time.RFC3339Nano)
	extra := ""
	if len(data) > 0 {
		extra = fmt.Sprintf(" %v", data)
	}
	line := fmt.Sprintf("[%s] %s spider-browser: %s%s\n", ts, level, msg, extra)
	if level == "ERROR" || level == "WARN" {
		fmt.Fprint(os.Stderr, line)
	} else {
		fmt.Fprint(os.Stdout, line)
	}
}
