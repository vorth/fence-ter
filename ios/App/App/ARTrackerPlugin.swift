import UIKit
import ARKit
import Capacitor

/// Root view controller; registers the app's own (non-npm) plugins.
class AppViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(ARTrackerPlugin())
    }
}

/// Tracks the phone's position with ARKit world tracking (camera + motion
/// sensors), showing the live camera in a native view laid over a rectangle
/// of the web view. The world is aligned to gravity and compass heading, so
/// positions come out as metres east, north and up from where `start` was
/// called.
@objc(ARTrackerPlugin)
public class ARTrackerPlugin: CAPPlugin, CAPBridgedPlugin, ARSessionDelegate {
    public let identifier = "ARTrackerPlugin"
    public let jsName = "ARTracker"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isSupported", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setFrame", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPosition", returnType: CAPPluginReturnPromise),
    ]

    /// `pose` events per second; ARKit delivers frames at 60.
    private static let poseRate: TimeInterval = 15

    private var arView: ARSCNView?
    private var lastPoseTime: TimeInterval = 0

    @objc func isSupported(_ call: CAPPluginCall) {
        call.resolve(["supported": ARWorldTrackingConfiguration.isSupported])
    }

    /// Starts a new session (the origin is the phone's position now) and shows
    /// the camera at `x`, `y`, `width`, `height` in web view (CSS) pixels.
    @objc func start(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard ARWorldTrackingConfiguration.isSupported else {
                call.reject("This device doesn’t support ARKit world tracking.")
                return
            }
            // Capacitor's view controller uses the web view as its view, so a
            // subview sits above the page and doesn't scroll with it.
            guard let webView = self.bridge?.webView else {
                call.reject("Web view unavailable")
                return
            }
            self.tearDown()
            let view = ARSCNView(frame: Self.frame(call))
            view.automaticallyUpdatesLighting = false
            view.session.delegate = self
            webView.addSubview(view)
            self.arView = view

            let config = ARWorldTrackingConfiguration()
            config.worldAlignment = .gravityAndHeading
            view.session.run(config, options: [.resetTracking, .removeExistingAnchors])
            call.resolve()
        }
    }

    /// Moves the camera view, e.g. after the page's layout changes.
    @objc func setFrame(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.arView?.frame = Self.frame(call)
            call.resolve()
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.tearDown()
            call.resolve()
        }
    }

    /// The latest pose (see `pose(_:)`), or an empty object before the first frame.
    @objc func getPosition(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let frame = self.arView?.session.currentFrame else {
                call.resolve([:])
                return
            }
            call.resolve(Self.pose(frame.camera))
        }
    }

    private func tearDown() {
        arView?.session.pause()
        arView?.removeFromSuperview()
        arView = nil
    }

    private static func frame(_ call: CAPPluginCall) -> CGRect {
        CGRect(
            x: call.getDouble("x") ?? 0,
            y: call.getDouble("y") ?? 0,
            width: call.getDouble("width") ?? 0,
            height: call.getDouble("height") ?? 0
        )
    }

    /// Position in metres (x east, y north, z up) and tracking quality:
    /// `good`, `limited` (usable, less accurate) or `lost` (don't record).
    private static func pose(_ camera: ARCamera) -> [String: Any] {
        // With .gravityAndHeading, ARKit's +x is east, +y up and -z north.
        let t = camera.transform.columns.3
        var result: [String: Any] = ["x": Double(t.x), "y": Double(-t.z), "z": Double(t.y)]
        switch camera.trackingState {
        case .normal:
            result["quality"] = "good"
            result["detail"] = "Tracking"
        case .notAvailable:
            result["quality"] = "lost"
            result["detail"] = "Tracking unavailable"
        case .limited(let reason):
            switch reason {
            case .initializing:
                result["quality"] = "lost"
                result["detail"] = "Starting — move the phone slowly"
            case .relocalizing:
                result["quality"] = "lost"
                result["detail"] = "Recovering — point back where you were"
            case .excessiveMotion:
                result["quality"] = "limited"
                result["detail"] = "Moving too fast"
            case .insufficientFeatures:
                result["quality"] = "limited"
                result["detail"] = "Not enough detail in view"
            @unknown default:
                result["quality"] = "limited"
                result["detail"] = "Tracking limited"
            }
        }
        return result
    }

    // MARK: ARSessionDelegate

    public func session(_ session: ARSession, didUpdate frame: ARFrame) {
        let now = frame.timestamp
        guard now - lastPoseTime >= 1 / Self.poseRate else { return }
        lastPoseTime = now
        notifyListeners("pose", data: Self.pose(frame.camera))
    }

    public func session(_ session: ARSession, didFailWithError error: Error) {
        notifyListeners("error", data: ["message": error.localizedDescription])
    }
}
