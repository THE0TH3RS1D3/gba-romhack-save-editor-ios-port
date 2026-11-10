import SwiftUI
import WebKit
import UIKit

@main
struct GBASaveEditorApp: App {
    var body: some Scene {
        WindowGroup {
            WebContainer()
                .ignoresSafeArea(.container, edges: .all)
        }
    }
}

/// Hosts the editor (HTML/JS in the "www" bundle folder) in a WKWebView.
struct WebContainer: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(AssetSchemeHandler(), forURLScheme: "app")
        config.userContentController.add(context.coordinator, name: "native")
        let web = WKWebView(frame: .zero, configuration: config)
        web.isOpaque = false
        web.backgroundColor = UIColor.systemBackground
        web.scrollView.backgroundColor = UIColor.systemBackground
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.scrollView.bounces = false
        web.load(URLRequest(url: URL(string: "app://localhost/index.html")!))
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    /// Receives {type:"export", name, data(base64)} from the page and opens the iOS share sheet
    /// ("Save to Files", AirDrop, ...).
    final class Coordinator: NSObject, WKScriptMessageHandler {
        func userContentController(_ userContentController: WKUserContentController,
                                   didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any],
                  (body["type"] as? String) == "export",
                  let rawName = body["name"] as? String,
                  let b64 = body["data"] as? String,
                  let data = Data(base64Encoded: b64) else { return }
            let name = rawName.replacingOccurrences(of: "/", with: "_")
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
            do {
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                let url = dir.appendingPathComponent(name.isEmpty ? "save.sav" : name)
                try data.write(to: url, options: .atomic)
                DispatchQueue.main.async { Coordinator.share(url) }
            } catch {
                print("export failed: \(error)")
            }
        }

        static func share(_ url: URL) {
            let scene = UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .first { $0.activationState == .foregroundActive } ??
                UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
            guard var top = scene?.windows.first(where: { $0.isKeyWindow })?.rootViewController
                    ?? scene?.windows.first?.rootViewController else { return }
            while let presented = top.presentedViewController { top = presented }
            let vc = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            if let pop = vc.popoverPresentationController {      // needed on iPad
                pop.sourceView = top.view
                pop.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.maxY - 40, width: 1, height: 1)
                pop.permittedArrowDirections = []
            }
            top.present(vc, animated: true)
        }
    }
}

/// Serves the bundled web app from app://localhost/ (gives IndexedDB / fetch a proper origin).
final class AssetSchemeHandler: NSObject, WKURLSchemeHandler {
    private static let mime: [String: String] = [
        "html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8",
        "css": "text/css; charset=utf-8", "png": "image/png", "json": "application/json",
        "svg": "image/svg+xml", "wasm": "application/wasm",
    ]

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url,
              let root = Bundle.main.resourceURL?.appendingPathComponent("www", isDirectory: true) else {
            urlSchemeTask.didFailWithError(URLError(.badURL))
            return
        }
        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }
        let fileURL = root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
        guard fileURL.path.hasPrefix(root.standardizedFileURL.path),
              let data = try? Data(contentsOf: fileURL) else {
            let resp = HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: nil)!
            urlSchemeTask.didReceive(resp)
            urlSchemeTask.didFinish()
            return
        }
        let type = AssetSchemeHandler.mime[fileURL.pathExtension.lowercased()] ?? "application/octet-stream"
        let resp = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                                   headerFields: ["Content-Type": type, "Content-Length": String(data.count),
                                                  "Cache-Control": "no-cache"])!
        urlSchemeTask.didReceive(resp)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}
