#!/usr/bin/env python
"""
  Turkish Deasciifier pattern compilation code.
  Author: Mustafa Emre Acer
  This script compiles the patterns and creates a dictionary from the pattern
  array. It then fills the pattern template with the generated pattern string to
  produce a final patterns.js file.
"""
import datetime
import json
import sys

def CompilePatternsV2(pattern_json_path):
  """Converts the pattern json to ranked pattern list.
  Args:
    pattern_json_path: str, Path of the json file containing the patterns.
  """
  keys = ['c', 'g', 'i', 'o', 's', 'u']
  key_strings = []
  print("Generating patterns v2...")
  with open(pattern_json_path) as pattern_json:
    patterns = json.loads(pattern_json.read())
    for key in keys:
      entries = patterns[key]
      computed_entries = []
      for entry in entries:
        pattern = entry[0]
        computed_string = pattern
        if entry[1] < 0:
          computed_string = "-" + computed_string
        computed_entries.append(computed_string)

      key_string = '\"%s\":"%s"' % (key, '|'.join(computed_entries))
      key_strings.append(key_string)

    # The output string.
    pattern_string = '{\n%s\n};' % ',\n'.join(key_strings)
    return pattern_string

def CompilePatternTemplate(pattern_template_path, pattern_string, output_path):
  """Compiles the pattern template by filling in the pattern string.
  Args:
    pattern_template_path: str, Path of the template to be filled.
    pattern_string: str, Computed pattern string to be filled into the template.
    output_path: str, Path of the output file.
  """
  with open(pattern_template_path) as pattern_template:
    template = pattern_template.read()
    with open(output_path, 'w') as output_file:
      # Skip the comment on the first line.
      template = '\n'.join(template.split('\n')[1:])
      output_file.write('// File generated at %s, don\'t edit.\n' %
          datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
      output_file.write(template.replace('$COMPILED_PATTERNS$', pattern_string))


if __name__ == "__main__":
  if len(sys.argv) == 4:
    pattern_string = CompilePatternsV2(sys.argv[1])
    template_path = sys.argv[2]
    output_path = sys.argv[3]
    CompilePatternTemplate(template_path, pattern_string, output_path)
  else:
    print(("\nUsage: compile_patterns.py "
          "<pattern_v2_json_path> <template_path> <output_path>\n"))
    exit(-1)