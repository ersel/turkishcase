
.SILENT:

.PHONY:

all:

initialize:

finalize:

clean:

vsce-pack:
	vsce package
	mv *.vsix .output/

vsce-publish:
	vsce publish

package: initialize clean vsce-pack finalize

publish: initialize clean vsce-publish finalize

patterns: 
	./build_patterns.py ./lib/deasciifier/patterns.json ./lib/deasciifier/template.js ./lib/deasciifier/compiled_templates.js