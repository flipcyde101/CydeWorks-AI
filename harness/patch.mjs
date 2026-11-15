function patchLines(text,prefix) {
  if (!text) return [];
  const lines=text.split('\n');
  const hasFinalNewline=text.endsWith('\n');
  if (hasFinalNewline) lines.pop();
  const patch=lines.map(line=>prefix+line);
  if (!hasFinalNewline) patch.push('\\ No newline at end of file');
  return patch;
}

export function unifiedPatch(filename,before,after) {
  if (before===after) return '';
  const lineCount=text=>text ? text.split('\n').length-(text.endsWith('\n')?1:0) : 0;
  const range=text=>lineCount(text) ? '1,'+lineCount(text) : '0,0';
  return ['--- a/'+filename,'+++ b/'+filename,'@@ -'+range(before)+' +'+range(after)+' @@',
    ...patchLines(before,'-'),...patchLines(after,'+')].join('\n')+'\n';
}
