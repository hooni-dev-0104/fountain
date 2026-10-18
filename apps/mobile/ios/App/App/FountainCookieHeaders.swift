import Foundation

enum FountainCookieHeaderError: Error { case invalid }
enum FountainCookieHeaders {
    // HTTPURLResponse combines repeated Set-Cookie fields. An Expires date's
    // comma is not followed by a cookie-name= pair and must remain intact.
    static func target(_ header: String, name: String) throws -> String {
        guard header.utf8.count <= 8192, !header.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { throw FountainCookieHeaderError.invalid }
        let expression = try NSRegularExpression(pattern: #",\s*(?=[!#$%&'*+\-.^_`|~0-9A-Za-z]+=)"#)
        let text = header as NSString, matches = expression.matches(in: header, range: NSRange(location: 0, length: text.length))
        guard matches.count < 8 else { throw FountainCookieHeaderError.invalid }
        var segments: [String] = [], offset = 0
        for match in matches {
            segments.append(text.substring(with: NSRange(location: offset, length: match.range.location - offset)).trimmingCharacters(in: .whitespaces))
            offset = NSMaxRange(match.range)
        }
        segments.append(text.substring(from: offset).trimmingCharacters(in: .whitespaces))
        var selected: String?, seen = Set<String>()
        for segment in segments {
            guard let pair = segment.split(separator: ";", maxSplits: 1, omittingEmptySubsequences: false).first else { throw FountainCookieHeaderError.invalid }
            let cookie = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard cookie.count == 2, cookie[0].range(of: #"^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$"#, options: .regularExpression) != nil,
                  seen.insert(String(cookie[0])).inserted else { throw FountainCookieHeaderError.invalid }
            if cookie[0] == name { selected = segment }
            // This observed infrastructure cookie is never stored or sent by
            // Fountain. Every app/unknown companion remains fail closed.
            else if cookie[0] != "__cf_bm" { throw FountainCookieHeaderError.invalid }
        }
        guard let selected else { throw FountainCookieHeaderError.invalid }
        return selected
    }
}
