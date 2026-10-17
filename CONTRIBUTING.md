# Adding a rule

There are two ways. Start with a data rule. It needs no code.

## Data rules (JSON)

Add an object to a file in `rules/packs/` (or create a new pack file). Every rule carries its own fixture, a log line that must trigger it, and the test suite checks that automatically.

```json
{
  "id": "no-handler-list",
  "severity": "error",
  "title": "Plugin listens for an event that does not exist: {1}",
  "match": "Unable to find handler list for event (\\S+)",
  "key": 1,
  "explain": "A plugin tried to listen to {1}, which this server does not provide.",
  "fix": ["Check the plugin supports your server software and version."],
  "fixture": "[10:00:00 ERROR]: Unable to find handler list for event com.example.FooEvent."
}
```

| Field | Meaning |
| --- | --- |
| `id`, `severity`, `title`, `match`, `explain`, `fix`, `fixture` | Required. `match` is a regular expression as a string (double the backslashes). `fix` is a list of steps |
| `flags` | Regex flags, for example `"i"` |
| `key` | Capture group number. Hits with different values become separate findings |
| `plugin` | Capture group number, or a fixed plugin name, to attribute the problem |
| `context` | Also show this many lines after the first hit |
| `mergeWithin` | Count hits within this many lines of each other once |
| `replaces` | Ids of more general rules to hide when this one fires |

Placeholders `{1}`, `{2}` (captures), `{plugin}` and `{count}` work in `title`, `explain` and `fix`. Run `npm test` to check the fixture fires and that no placeholder is left unfilled.

## JavaScript rules

For logic a regex cannot express, a rule is a plain object in `src/rules.js`. Add it to the `rules` array, add a line to a sample log if it needs one, and run `npm test`.

```js
{
  id: 'port-in-use',
  severity: 'critical',
  title: 'Port already in use',
  match: /FAILED TO BIND TO PORT|Address already in use/i,
  explain: 'Another program is already using the server port.',
  fix: [
    'Close the other server.',
    'Or change server-port in server.properties.'
  ]
}
```

## Fields

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Unique lowercase slug |
| `severity` | yes | `critical` (server down), `error` (a feature is broken), `warning` (should fix), `info` (good to know). Can be a function of the finding |
| `title` | yes | Short headline |
| `match` | yes* | Regex tested on every log line. Do not use the `g` flag. Captures become `{1}`, `{2}`... |
| `check` | yes* | Instead of `match`, a function `(ctx) => null or { summary, fix }` for rules about the plugin list |
| `explain` | yes | What it means, in plain words. String or function of the finding |
| `fix` | yes | Array of steps. Strings or functions |
| `key` | no | `(match) => string`. Hits with different keys become separate findings, for example one per plugin |
| `filter` | no | `(hit) => boolean`. Drop hits that should not count |
| `plugin` | no | `(finding) => plugin name`. Otherwise it comes from the stack trace |
| `vars` | no | `(finding) => object` of extra placeholders |
| `context` | no | Also show this many lines after the first hit |
| `mergeWithin` | no | Count hits within this many lines of each other once |
| `replaces` | no | Ids of more general rules to hide when this one fires |

\* One of `match` or `check`.

Placeholders usable in strings: `{1}`, `{2}` (regex captures), `{plugin}`, `{count}`, and anything returned by `vars`.

Inside functions you get the finding `f` with `f.m` (first match), `f.all` (all matches), `f.count`, `f.plugin`, `f.info`, `f.grep(regex)` to search the whole log, and `f.hits[0].after(n)`, `.near(regex, before, after)` and `.scanPlugin(n)` to look at nearby lines.

## Writing good rules

- Match the exact wording the server prints. Copy a real line from a real log.
- Say what it means before saying what to do.
- Give steps in the order someone should try them, safest first.
- Plain words, no jargon the reader did not already meet in the log.
- Do not guess. If a message has several possible causes, say so and list them.
- No emojis, no em dashes.

## Tests

Put a short real log in `samples/` if the rule needs one and assert its id in `tests/engine.test.js`. Mention the sample in `scripts/build.js` if you want it in the web page's example menu.