// A non-interactive stand-in for $EDITOR used by the verify harness: it appends a marker line
// to the file it is given, simulating a human editing and saving.
import { readFileSync, writeFileSync } from 'node:fs'
const file = process.argv[2]
const text = readFileSync(file, 'utf8')
writeFileSync(file, text + '\n\nEdited by the CLI test.')
