import unittest

from fountain.core import APIError, Store, Workspace
from fountain.advanced import Advanced
from fountain.richtext import blocks_html, inline_markdown


class RichTextTests(unittest.TestCase):
    def setUp(self):
        self.store = Store(':memory:')
        self.workspace = Workspace(self.store)

    def tearDown(self):
        self.store.close()

    def blocks(self):
        return [{'id': 'parent', 'type': 'heading2', 'text': '<제목>', 'rich_text': [
            {'text': '<제목>', 'marks': {'bold': True, 'italic': True, 'underline': True, 'strike': True,
                'code': True, 'color': 'red', 'background': 'yellow', 'link': 'https://example.org/?q="'}}]},
            {'id': 'child', 'type': 'todo', 'parent_id': 'parent', 'text': '가족🙂', 'checked': True}]

    def test_publishing_and_clipboard_keep_marks_and_nested_depth_escaped(self):
        blocks = self.blocks()
        page = self.workspace.create_page({'title': '서식', 'blocks': blocks})
        service = Advanced(self.store, self.workspace)
        self.store.put('site', {'id': 'site', 'page_id': page['id'], 'slug': 'rich', 'published': True})
        document = service.dispatch('GET', '/sites/rich', {}, {})[1]['_html']
        self.assertIn('<strong>', document)
        self.assertIn('&lt;제목&gt;', document)
        self.assertNotIn('<제목>', document)
        self.assertIn('href="https://example.org/?q=&quot;"', document)
        self.assertIn('margin-left:24px', document)
        self.assertIn('☑ 가족🙂', document)
        clipboard = service.clipboard({'blocks': blocks})
        self.assertIn('<strong>', clipboard['html'])
        self.assertEqual(clipboard['text'], '<제목>\n가족🙂')

    def test_raw_html_and_unsafe_or_unknown_marks_rejected_before_storage(self):
        before = len(self.store.list('page'))
        for marks in [{'link': 'javascript:alert(1)'}, {'link': '//evil.test/'}, {'link': 'data:text/html,bad'},
                      {'color': 'red;position:absolute'}, {'onerror': 'alert(1)'}, {'bold': 'false'}]:
            with self.subTest(marks=marks), self.assertRaises(APIError):
                self.workspace.create_page({'blocks': [{'text': 'X', 'rich_text': [{'text': 'X', 'marks': marks}]}]})
        self.assertEqual(len(self.store.list('page')), before)
        self.assertIn('&lt;img', blocks_html([{'text': '<img src=x onerror=alert(1)>'}]))

    def test_legacy_plaintext_replacement_clears_stale_marks(self):
        page = self.workspace.create_page({'blocks': self.blocks()})
        block = page['blocks'][0]
        block['text'] = '새 내용'
        saved = self.workspace.save_blocks(page['id'], [block])
        self.assertEqual(saved['blocks'][0]['rich_text'], [{'text': '새 내용', 'marks': {}}])

    def test_markdown_export_preserves_marks_and_safe_code_fences(self):
        self.workspace.create_page({'title': '서식', 'blocks': [
            {'id': 'a', 'text': '굵게', 'rich_text': [{'text': '굵게', 'marks': {'bold': True}}]},
            {'id': 'b', 'type': 'bullet', 'parent_id': 'a', 'text': '자녀'},
            {'id': 'c', 'type': 'code', 'text': '```\nconst text = "가";'}]})
        content = self.workspace.export('markdown')['content']
        self.assertIn('**굵게**', content)
        self.assertIn('  - 자녀', content)
        self.assertIn('````\n```\nconst text', content)
        self.assertEqual(inline_markdown({'rich_text': [{'text': 'a`b', 'marks': {'code': True}}]}), '``a`b``')


if __name__ == '__main__': unittest.main()
