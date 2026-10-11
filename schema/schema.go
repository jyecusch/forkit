// Package schema embeds the JSON Schema that defines Forkit's shared data
// model. Go types and Effect Schemas are generated from it.
package schema

import _ "embed"

//go:generate go run ../tools/schemagen -schema forkit.schema.json -go ../internal/model/model_gen.go -ts ../frontend/src/model/model.gen.ts

//go:embed forkit.schema.json
var JSON []byte
