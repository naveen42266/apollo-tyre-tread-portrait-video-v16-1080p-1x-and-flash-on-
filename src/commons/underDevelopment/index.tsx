import React from "react";
import { AlertTriangle } from "lucide-react";

interface UnderDevelopmentProps {
    name: string;
}

const UnderDevelopment: React.FC<UnderDevelopmentProps> = ({ name }) => {
    return (
        <div className="h-full w-full flex flex-col items-center justify-center text-secondary font-montserrat px-4 text-center">
            <AlertTriangle className="w-16 h-16 text-yellow-400 mb-4" />
            <h1 className="text-xl md:text-2xl font-semibold mb-2">
                This {name || ""} Feature is Under Development
            </h1>
            <p className="text-sm md:text-base text-secondary/80 max-w-md">
                We’re working hard to bring this feature to you soon. Stay tuned for updates!
            </p>
        </div>
    );
};

export default UnderDevelopment;
