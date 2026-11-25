package org.vorthmann.fenceter;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ARTrackerPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
