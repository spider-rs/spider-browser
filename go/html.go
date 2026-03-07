package spiderbrowser

import "strings"

// TruncateHTML truncates HTML to roughly maxChars, breaking at a tag boundary.
func TruncateHTML(html string, maxChars int) string {
	if len(html) <= maxChars {
		return html
	}
	slice := html[:maxChars]
	lastClose := strings.LastIndex(slice, ">")
	if lastClose > 0 {
		return html[:lastClose+1]
	}
	return slice
}
