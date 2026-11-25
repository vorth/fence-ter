package org.vorthmann.fenceter;

import android.Manifest;
import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.opengl.GLES11Ext;
import android.opengl.GLES20;
import android.opengl.GLSurfaceView;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.ViewGroup;
import android.webkit.WebView;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.ar.core.ArCoreApk;
import com.google.ar.core.Camera;
import com.google.ar.core.Config;
import com.google.ar.core.Coordinates2d;
import com.google.ar.core.Frame;
import com.google.ar.core.Pose;
import com.google.ar.core.Session;
import com.google.ar.core.TrackingState;
import com.google.ar.core.exceptions.UnavailableDeviceNotCompatibleException;
import com.google.ar.core.exceptions.UnavailableException;
import com.google.ar.core.exceptions.UnavailableUserDeclinedInstallationException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import javax.microedition.khronos.egl.EGLConfig;
import javax.microedition.khronos.opengles.GL10;

/**
 * Tracks the phone's position with ARCore (camera + motion sensors), showing
 * the live camera in a GLSurfaceView laid over a rectangle of the web view.
 * Same interface as the iOS ARKit plugin: positions are metres east (x),
 * north (y) and up (z) from where tracking started.
 *
 * ARCore's world has y up but an arbitrary heading. North comes from the
 * rotation-vector sensor (magnetometer-based): while the camera points well
 * away from straight down, the difference between its heading by the compass
 * and its heading in ARCore's world is averaged, then fixed after
 * HEADING_SAMPLES samples so earlier points don't shift.
 */
@CapacitorPlugin(
    name = "ARTracker",
    permissions = { @Permission(strings = { Manifest.permission.CAMERA }, alias = "camera") }
)
public class ARTrackerPlugin extends Plugin implements GLSurfaceView.Renderer, SensorEventListener {

    private static final String TAG = "ARTracker";
    /** `pose` events per second; ARCore delivers camera frames at about 30. */
    private static final long POSE_INTERVAL_MS = 1000 / 15;
    /** Heading samples averaged before the north offset is fixed. */
    private static final int HEADING_SAMPLES = 45;
    /** A view direction counts for heading only if at least this much of it is horizontal. */
    private static final double MIN_HORIZONTAL = 0.3;

    private final Handler main = new Handler(Looper.getMainLooper());
    private boolean installRequested = false;

    // Owned by the main thread; read by the GL thread.
    private volatile Session session;
    private GLSurfaceView surface;
    private SensorManager sensors;

    // GL thread state.
    private int textureId = -1;
    private int program;
    private int positionAttrib;
    private int texCoordAttrib;
    private final FloatBuffer quadCoords = floats(new float[] { -1, -1, 1, -1, -1, 1, 1, 1 });
    private final FloatBuffer quadTexCoords = floats(new float[8]);
    private long lastPoseTime = 0;
    private float[] origin;
    private double headingSin = 0;
    private double headingCos = 0;
    private int headingCount = 0;

    // Latest compass rotation matrix (device axes → east/north/up), from the sensor thread.
    private final float[] rotation = new float[9];
    private volatile boolean haveRotation = false;

    // Latest pose, for getPosition; guarded by `this`.
    private JSObject latestPose = null;

    @PluginMethod
    public void isSupported(PluginCall call) {
        checkAvailability(call, 0);
    }

    /** Availability can take a moment to determine; poll for up to about 2 s. */
    private void checkAvailability(PluginCall call, int attempt) {
        ArCoreApk.Availability a = ArCoreApk.getInstance().checkAvailability(getContext());
        if (a.isTransient() && attempt < 10) {
            main.postDelayed(() -> checkAvailability(call, attempt + 1), 200);
            return;
        }
        JSObject result = new JSObject();
        result.put("supported", a.isSupported());
        call.resolve(result);
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            requestPermissionForAlias("camera", call, "cameraPermissionCallback");
            return;
        }
        main.post(() -> startSession(call));
    }

    @PermissionCallback
    private void cameraPermissionCallback(PluginCall call) {
        if (getPermissionState("camera") == PermissionState.GRANTED) {
            main.post(() -> startSession(call));
        } else {
            call.reject("Camera access is needed to measure.");
        }
    }

    private void startSession(PluginCall call) {
        try {
            ArCoreApk.InstallStatus status = ArCoreApk.getInstance().requestInstall(getActivity(), !installRequested);
            if (status == ArCoreApk.InstallStatus.INSTALL_REQUESTED) {
                installRequested = true;
                call.reject("Install Google Play Services for AR, then tap Measure again.");
                return;
            }
            tearDown();
            Session s = new Session(getContext());
            Config config = new Config(s);
            config.setFocusMode(Config.FocusMode.AUTO);
            s.configure(config);

            origin = null;
            headingSin = headingCos = 0;
            headingCount = 0;
            synchronized (this) {
                latestPose = null;
            }

            surface = new GLSurfaceView(getContext());
            surface.setPreserveEGLContextOnPause(true);
            surface.setEGLContextClientVersion(2);
            surface.setEGLConfigChooser(8, 8, 8, 8, 16, 0);
            surface.setRenderer(this);
            surface.setRenderMode(GLSurfaceView.RENDERMODE_CONTINUOUSLY);
            // Above the web view's window surface, so the page can't cover it.
            surface.setZOrderOnTop(true);
            ViewGroup parent = (ViewGroup) getBridge().getWebView().getParent();
            parent.addView(surface, new ViewGroup.LayoutParams(0, 0));
            place(call);

            s.resume();
            session = s;
            surface.onResume();

            sensors = (SensorManager) getContext().getSystemService(Context.SENSOR_SERVICE);
            Sensor rv = sensors.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR);
            if (rv != null) sensors.registerListener(this, rv, SensorManager.SENSOR_DELAY_GAME);
            call.resolve();
        } catch (UnavailableDeviceNotCompatibleException e) {
            tearDown();
            call.reject("This phone doesn’t support ARCore.");
        } catch (UnavailableUserDeclinedInstallationException e) {
            tearDown();
            call.reject("Google Play Services for AR is needed to measure.");
        } catch (UnavailableException e) {
            tearDown();
            call.reject("ARCore is unavailable: " + e.getMessage());
        } catch (Exception e) {
            tearDown();
            call.reject("Couldn’t start ARCore: " + e.getMessage());
        }
    }

    /** Moves the camera view, e.g. after the page's layout changes. */
    @PluginMethod
    public void setFrame(PluginCall call) {
        main.post(() -> {
            place(call);
            call.resolve();
        });
    }

    /** Positions the surface at the call's `x`, `y`, `width`, `height`, in CSS pixels of the web view. */
    private void place(PluginCall call) {
        if (surface == null) return;
        WebView web = getBridge().getWebView();
        float d = getContext().getResources().getDisplayMetrics().density;
        ViewGroup.LayoutParams lp = surface.getLayoutParams();
        lp.width = Math.round(call.getFloat("width", 0f) * d);
        lp.height = Math.round(call.getFloat("height", 0f) * d);
        surface.setLayoutParams(lp);
        surface.setX(web.getX() + call.getFloat("x", 0f) * d);
        surface.setY(web.getY() + call.getFloat("y", 0f) * d);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        main.post(() -> {
            tearDown();
            call.resolve();
        });
    }

    /** The latest pose (see `pose`), or an empty object before the first frame. */
    @PluginMethod
    public void getPosition(PluginCall call) {
        synchronized (this) {
            call.resolve(latestPose != null ? latestPose : new JSObject());
        }
    }

    @Override
    protected void handleOnPause() {
        tearDown();
    }

    private void tearDown() {
        if (sensors != null) {
            sensors.unregisterListener(this);
            sensors = null;
        }
        haveRotation = false;
        if (surface != null) {
            // Waits for the GL thread to stop drawing, so the session can be closed.
            surface.onPause();
            ((ViewGroup) surface.getParent()).removeView(surface);
            surface = null;
        }
        Session s = session;
        session = null;
        if (s != null) {
            s.pause();
            s.close();
        }
        textureId = -1;
        synchronized (this) {
            latestPose = null;
        }
    }

    // ---------- Compass ----------

    @Override
    public void onSensorChanged(SensorEvent event) {
        synchronized (rotation) {
            SensorManager.getRotationMatrixFromVector(rotation, event.values);
        }
        haveRotation = true;
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {}

    // ---------- Rendering (GL thread) ----------

    private static final String VERTEX_SHADER =
        "attribute vec4 a_Position;\n" +
        "attribute vec2 a_TexCoord;\n" +
        "varying vec2 v_TexCoord;\n" +
        "void main() {\n" +
        "  gl_Position = a_Position;\n" +
        "  v_TexCoord = a_TexCoord;\n" +
        "}\n";

    private static final String FRAGMENT_SHADER =
        "#extension GL_OES_EGL_image_external : require\n" +
        "precision mediump float;\n" +
        "varying vec2 v_TexCoord;\n" +
        "uniform samplerExternalOES sTexture;\n" +
        "void main() {\n" +
        "  gl_FragColor = texture2D(sTexture, v_TexCoord);\n" +
        "}\n";

    @Override
    public void onSurfaceCreated(GL10 gl, EGLConfig config) {
        GLES20.glClearColor(0f, 0f, 0f, 1f);
        int[] tex = new int[1];
        GLES20.glGenTextures(1, tex, 0);
        textureId = tex[0];
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, textureId);
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE);
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE);
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR);
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR);

        program = GLES20.glCreateProgram();
        GLES20.glAttachShader(program, shader(GLES20.GL_VERTEX_SHADER, VERTEX_SHADER));
        GLES20.glAttachShader(program, shader(GLES20.GL_FRAGMENT_SHADER, FRAGMENT_SHADER));
        GLES20.glLinkProgram(program);
        positionAttrib = GLES20.glGetAttribLocation(program, "a_Position");
        texCoordAttrib = GLES20.glGetAttribLocation(program, "a_TexCoord");

        Session s = session;
        if (s != null) s.setCameraTextureName(textureId);
    }

    @Override
    public void onSurfaceChanged(GL10 gl, int width, int height) {
        GLES20.glViewport(0, 0, width, height);
        Session s = session;
        if (s != null) {
            int rotation = getActivity().getWindowManager().getDefaultDisplay().getRotation();
            s.setDisplayGeometry(rotation, width, height);
        }
    }

    @Override
    public void onDrawFrame(GL10 gl) {
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT | GLES20.GL_DEPTH_BUFFER_BIT);
        Session s = session;
        if (s == null || textureId < 0) return;
        Frame frame;
        try {
            s.setCameraTextureName(textureId);
            frame = s.update();
        } catch (Exception e) {
            Log.w(TAG, "Session update failed", e);
            String message = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
            main.post(() -> {
                JSObject data = new JSObject();
                data.put("message", message);
                notifyListeners("error", data);
            });
            return;
        }
        // Map the camera image onto the view, cropped to its shape. This must
        // come before the timestamp check: ARCore reports the change only once,
        // typically on the first frame, which has no image yet. Skipping it
        // left the texture coordinates all zero, stretching one camera pixel
        // over the whole view.
        if (frame.hasDisplayGeometryChanged()) {
            quadCoords.position(0);
            quadTexCoords.position(0);
            frame.transformCoordinates2d(
                Coordinates2d.OPENGL_NORMALIZED_DEVICE_COORDINATES, quadCoords,
                Coordinates2d.TEXTURE_NORMALIZED, quadTexCoords);
        }
        if (frame.getTimestamp() == 0) return; // No camera image yet.
        drawBackground();
        updatePose(frame.getCamera());
    }

    private void drawBackground() {
        GLES20.glDisable(GLES20.GL_DEPTH_TEST);
        GLES20.glUseProgram(program);
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0);
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, textureId);
        quadCoords.position(0);
        quadTexCoords.position(0);
        GLES20.glVertexAttribPointer(positionAttrib, 2, GLES20.GL_FLOAT, false, 0, quadCoords);
        GLES20.glVertexAttribPointer(texCoordAttrib, 2, GLES20.GL_FLOAT, false, 0, quadTexCoords);
        GLES20.glEnableVertexAttribArray(positionAttrib);
        GLES20.glEnableVertexAttribArray(texCoordAttrib);
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4);
        GLES20.glDisableVertexAttribArray(positionAttrib);
        GLES20.glDisableVertexAttribArray(texCoordAttrib);
    }

    // ---------- Pose (GL thread) ----------

    private void updatePose(Camera camera) {
        JSObject pose = new JSObject();
        TrackingState state = camera.getTrackingState();
        if (state == TrackingState.TRACKING) {
            Pose p = camera.getPose();
            float[] t = p.getTranslation();
            if (origin == null) origin = t.clone();
            sampleHeading(p);

            // ARCore: y up, and a heading angle measured clockwise from -z.
            // Turn by the north offset to get east and north.
            double a = t[0] - origin[0];
            double b = -(t[2] - origin[2]);
            double phi = headingCount > 0 ? Math.atan2(headingSin, headingCos) : 0;
            pose.put("x", a * Math.cos(phi) + b * Math.sin(phi));
            pose.put("y", b * Math.cos(phi) - a * Math.sin(phi));
            pose.put("z", t[1] - origin[1]);
            if (headingCount >= HEADING_SAMPLES) {
                pose.put("quality", "good");
                pose.put("detail", "Tracking");
            } else {
                pose.put("quality", "limited");
                pose.put("detail", headingCount == 0
                    ? "Finding north — tilt the camera up"
                    : "Finding north…");
            }
        } else {
            pose.put("x", 0);
            pose.put("y", 0);
            pose.put("z", 0);
            pose.put("quality", "lost");
            pose.put("detail", state == TrackingState.PAUSED ? pausedDetail(camera) : "Tracking stopped");
        }
        synchronized (this) {
            latestPose = pose;
        }
        long now = System.currentTimeMillis();
        if (now - lastPoseTime >= POSE_INTERVAL_MS) {
            lastPoseTime = now;
            main.post(() -> notifyListeners("pose", pose));
        }
    }

    private static String pausedDetail(Camera camera) {
        switch (camera.getTrackingFailureReason()) {
            case INSUFFICIENT_LIGHT:
                return "Too dark";
            case EXCESSIVE_MOTION:
                return "Moving too fast";
            case INSUFFICIENT_FEATURES:
                return "Not enough detail in view";
            case CAMERA_UNAVAILABLE:
                return "Camera unavailable";
            case BAD_STATE:
                return "Tracking failed";
            default:
                return "Starting — move the phone slowly";
        }
    }

    /**
     * Adds a sample of (compass heading − ARCore heading) of the camera's view
     * direction, both clockwise from their north, while it is far enough from
     * vertical to have a heading.
     */
    private void sampleHeading(Pose p) {
        if (headingCount >= HEADING_SAMPLES || !haveRotation) return;
        // Camera looks along its -z axis, in ARCore world coordinates.
        float[] z = p.getZAxis();
        double vx = -z[0], vz = -z[2];
        if (Math.hypot(vx, vz) < MIN_HORIZONTAL) return;
        double arHeading = Math.atan2(vx, -vz);

        // The same direction (the device's -z axis, out of the back camera) by the compass.
        double east, north;
        synchronized (rotation) {
            east = -rotation[2];
            north = -rotation[5];
        }
        if (Math.hypot(east, north) < MIN_HORIZONTAL) return;
        double compassHeading = Math.atan2(east, north);

        double offset = compassHeading - arHeading;
        headingSin += Math.sin(offset);
        headingCos += Math.cos(offset);
        headingCount++;
    }

    // ---------- Helpers ----------

    private static int shader(int type, String source) {
        int s = GLES20.glCreateShader(type);
        GLES20.glShaderSource(s, source);
        GLES20.glCompileShader(s);
        int[] ok = new int[1];
        GLES20.glGetShaderiv(s, GLES20.GL_COMPILE_STATUS, ok, 0);
        if (ok[0] == 0) Log.e(TAG, "Shader compile failed: " + GLES20.glGetShaderInfoLog(s));
        return s;
    }

    private static FloatBuffer floats(float[] values) {
        FloatBuffer b = ByteBuffer.allocateDirect(values.length * 4).order(ByteOrder.nativeOrder()).asFloatBuffer();
        b.put(values);
        b.position(0);
        return b;
    }
}
